import asyncio, sys, json, time
from playwright.async_api import async_playwright
SP=sys.argv[1]; U='http://localhost:8765/'
SDK='https://www.gstatic.com/firebasejs/10.12.2/'
FS=open(SP+'/fakefb/firestore.js').read()
APP="export const initializeApp=()=>({});export const getApps=()=>[];export const getApp=()=>({});"
AUTH="export const getAuth=()=>({currentUser:null});export const initializeAuth=()=>({currentUser:null});export const browserLocalPersistence={};export const inMemoryPersistence={};export const signInAnonymously=async(a)=>{a.currentUser={uid:'u'};return {};};"

class Cloud:
    def __init__(s):
        s.docs={}; s.listeners={}; s.reads={}; s.writes=0
        s.clock=int(time.time()*1000)-3*86400000
        s.mute_listen=set(); s.fail_writes=set()  # «время сервера»: каждая запись +1 час
    def tick(s): s.clock+=3600000; return s.clock
    async def handle(s, source, payload):
        page=source['page']; a=json.loads(payload); who=page.__dict__.get('_who','?')
        if a['op']=='listen' and who in s.mute_listen:
            s.listeners[(id(page),a['lid'])]=(page,a['path'],10**15,who,a['lid']); return json.dumps({'ok':True})
        if a['op']=='write' and who in s.fail_writes:
            raise Exception('unavailable')
        if a['op']=='listen':
            s.listeners[(id(page),a['lid'])]=(page,a['path'],a['min'],who,a['lid'])
            res=[{'id':i,'v':d['v'],'del':d['del'],'t':d['t'],'type':'added'} for (p,i),d in s.docs.items() if p==a['path'] and d['t']>a['min']]
            s.reads[who]=s.reads.get(who,0)+max(1,len(res))
            asyncio.create_task(page.evaluate("([l,c])=>window.__fbPush(l,c)",[a['lid'],res]))
        elif a['op']=='unlisten': s.listeners.pop((id(page),a['lid']),None)
        elif a['op']=='write':
            out=[]
            for o in a['ops']:
                s.writes+=1; t=s.tick(); k=(o['path'],o['id'])
                if o.get('remove'): s.docs.pop(k,None); out.append({'path':o['path'],'id':o['id'],'v':None,'del':False,'t':t,'type':'removed'})
                else: s.docs[k]={'v':o['v'],'del':o['del'],'t':t}; out.append({'path':o['path'],'id':o['id'],'v':o['v'],'del':o['del'],'t':t,'type':'modified'})
            for key,(pg,path,mn,w,lid) in list(s.listeners.items()):
                if pg.is_closed(): s.listeners.pop(key,None); continue
                ch=[{k:v for k,v in c.items() if k!='path'} for c in out if c['path']==path and (c['type']=='removed' or c['t']>mn)]
                if ch:
                    s.reads[w]=s.reads.get(w,0)+len(ch)
                    asyncio.create_task(pg.evaluate("([l,c])=>window.__fbPush(l,c)",[lid,ch]))
        return json.dumps({'ok':True})

cloud=Cloud()
async def phone(b, who):
    ctx=await b.new_context(viewport={'width':390,'height':844},locale='ru-RU',service_workers='block')
    await ctx.expose_binding('__fbCall', cloud.handle)
    for name,body in [('firebase-app.js',APP),('firebase-auth.js',AUTH),('firebase-firestore.js',FS)]:
        def mk(body):
            async def h(route): await route.fulfill(status=200,content_type='text/javascript',body=body)
            return h
        await ctx.route(SDK+name, mk(body))
    ctx._who=who
    return ctx
async def open_page(ctx, errs):
    pg=await ctx.new_page(); pg._who=ctx._who
    pg.on('pageerror',lambda e:errs.append(ctx._who+': '+str(e)))
    pg.on('dialog',lambda d:asyncio.ensure_future(d.accept()))
    return pg
S=lambda pg:pg.evaluate("JSON.parse(localStorage.getItem('malysh.v1'))")
def ev_ids(st,typ=None): return sorted(e['id'] for e in st['events'] if typ is None or e['type']==typ)
ok=lambda c,m: print(('OK   ' if c else 'FAIL ')+m)

async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--no-sandbox'])
        errs=[]
        A=await phone(b,'A'); B=await phone(b,'B')
        pa=await open_page(A,errs)
        await pa.goto(U)
        # У мамы уже 300 записей
        await pa.evaluate("""()=>{const ev=[];const t0=Date.now()-40*864e5;for(let i=0;i<300;i++)ev.push({id:'old'+i,type:i%2?'bottle':'stool',start:t0+i*3e6,ml:150,kind:'formula',color:'yellow'});
          localStorage.setItem('malysh.v1',JSON.stringify({profile:{name:'Миша',birth:'2026-05-10'},events:ev,growth:[],vacc:{done:{},custom:[]},solids:{},solidsCustom:[],timers:{}}));}""")
        await pa.reload(); await pa.wait_for_timeout(300)
        await pa.click('[data-act=settings]'); await pa.click('[data-x=sync-create]'); await pa.wait_for_timeout(800)
        code=await pa.evaluate("Sync.family"); print('family',code,'status',await pa.evaluate('Sync.status'))
        ok(len(cloud.docs)>=301, f'мама отправила записи в облако: {len(cloud.docs)}')
        # Папа подключается, у него 2 своих записи
        pb=await open_page(B,errs); await pb.goto(U)
        await pb.evaluate("""()=>localStorage.setItem('malysh.v1',JSON.stringify({profile:{name:'',birth:''},events:[{id:'dad1',type:'bottle',start:Date.now()-36e5,ml:120,kind:'formula'},{id:'dad2',type:'stool',start:Date.now()-2*36e5,color:'brown',cons:'soft'}],growth:[],vacc:{done:{},custom:[]},solids:{},solidsCustom:[],timers:{}}))""")
        await pb.reload(); await pb.wait_for_timeout(300)
        await pb.click('[data-act=settings]'); await pb.fill('[name=joincode]',code); await pb.click('[data-x=sync-join]'); await pb.wait_for_timeout(1200)
        sa,sb=await S(pa),await S(pb)
        ok(len(sb['events'])==302 and sb['profile']['name']=='Миша', f'папа получил все записи мамы + свои: {len(sb["events"])}, имя={sb["profile"]["name"]}')
        await pa.wait_for_timeout(500); sa=await S(pa)
        ok('dad1' in ev_ids(sa) and 'dad2' in ev_ids(sa), 'мама получила записи папы')
        # Мама добавляет бутылочку через интерфейс
        await pa.keyboard.press('Escape'); await pa.goto(U+'#feed'); await pa.wait_for_timeout(200)
        await pa.click('[data-act=add-bottle]'); await pa.fill('[name=ml]','210'); await pa.click('.sheet footer .btn.primary'); await pa.wait_for_timeout(700)
        sb=await S(pb); ok(any(e.get('ml')==210 for e in sb['events']), 'бутылочка мамы появилась у папы')
        # Папа удаляет запись old5, правит old7
        await pb.evaluate("()=>{const S0=JSON.parse(localStorage.getItem('malysh.v1'));}")
        await pb.keyboard.press('Escape')
        await pb.evaluate("()=>{S.events=S.events.filter(e=>e.id!=='old5');S.events.find(e=>e.id==='old7').ml=999;save();render();}")
        await pb.wait_for_timeout(700); sa=await S(pa)
        ok('old5' not in ev_ids(sa), 'удаление папы дошло до мамы')
        ok(next(e for e in sa['events'] if e['id']=='old7')['ml']==999, 'правка папы дошла до мамы')
        # Таймер сна: мама «уснул», папа «проснулся»
        await pa.goto(U+'#today'); await pa.wait_for_timeout(200)
        await pa.click('.sleep-card [data-act=sleep-toggle]'); await pa.wait_for_timeout(700)
        await pb.goto(U+'#today'); await pb.wait_for_timeout(500)
        ok(await pb.locator('.sleep-now [data-since]').count()==1, 'папа видит идущий сон мамы')
        await pb.evaluate("()=>{S.timers.sleep.start-=30*6e4;save();}"); await pb.wait_for_timeout(500)
        await pb.click('.sleep-card [data-act=sleep-toggle]'); await pb.wait_for_timeout(800)
        sa,sb=await S(pa),await S(pb)
        ok(not sa['timers'].get('sleep') and len(ev_ids(sa,'sleep'))==1 and ev_ids(sa,'sleep')==ev_ids(sb,'sleep'), f'сон завершён у обоих, записан один раз: {ev_ids(sa,"sleep")}')
        # Повторное открытие — сколько читает?
        before=cloud.reads.get('A',0)
        await pa.close(); pa=await open_page(A,errs); await pa.goto(U); await pa.wait_for_timeout(900)
        r=cloud.reads.get('A',0)-before
        ok(r<20, f'повторное открытие у мамы прочитало {r} записей из {len(cloud.docs)} (раньше читало бы все)')
        ok(await pa.evaluate('Sync.status')=='on', 'статус «работает»')
        # Изменение, пока мама «закрыла» приложение
        await pa.close()
        await pb.evaluate("()=>{S.events.push({id:'whileAway',type:'stool',start:Date.now(),color:'green'});S.events=S.events.filter(e=>e.id!=='old9');save();}"); await pb.wait_for_timeout(500)
        before=cloud.reads.get('A',0)
        pa=await open_page(A,errs); await pa.goto(U); await pa.wait_for_timeout(900)
        sa=await S(pa); r=cloud.reads.get('A',0)-before
        ok('whileAway' in ev_ids(sa) and 'old9' not in ev_ids(sa), f'после открытия мама получила пропущенные изменения (прочитано {r})')
        sa,sb=await S(pa),await S(pb)
        ok(ev_ids(sa)==ev_ids(sb) and sa['profile']==sb['profile'] or sa['profile']['name']==sb['profile']['name'], f'данные у мамы и папы совпадают: {len(sa["events"])} = {len(sb["events"])}')
        # Переход со старой версии: телефон бабушки (1.4) — merged:true, без state; в облаке old11 стёрт насовсем
        cloud.docs.pop(next(k for k in cloud.docs if k[1]=='ev_old11'))
        G=await phone(b,'G'); pg=await open_page(G,errs); await pg.goto(U)
        await pg.evaluate("""(code)=>{const ev=[];const t0=Date.now()-40*864e5;for(let i=0;i<300;i++)ev.push({id:'old'+i,type:i%2?'bottle':'stool',start:t0+i*3e6,ml:150,kind:'formula',color:'yellow'});
          localStorage.setItem('malysh.v1',JSON.stringify({profile:{name:'Миша',birth:'2026-05-10'},events:ev,growth:[],vacc:{done:{},custom:[]},solids:{},solidsCustom:[],timers:{}}));
          localStorage.setItem('malysh.sync',JSON.stringify({family:code,merged:true,dirty:false}));}""", code)
        await pg.reload(); await pg.wait_for_timeout(1200)
        sg=await S(pg); sb=await S(pb)
        ok('old11' not in ev_ids(sg) and 'old5' not in ev_ids(sg), 'старый телефон после обновления не воскресил удалённые записи')
        sa2=await S(pa); diff=set(ev_ids(sa2))^set(ev_ids(sg))
        ok(set(ev_ids(sg))==set(ev_ids(sa2))-{'old11'}, f'старый телефон совпал с облаком: {len(sg["events"])} (у мамы {len(sa2["events"])}, разница {sorted(diff)})')
        ok(not any(k[1]=='ev_old11' for k in cloud.docs), 'удалённая запись не вернулась в облако')
        print('reads', cloud.reads, 'writes', cloud.writes, 'docs', len(cloud.docs))
        print('errors', errs)
        await b.close()
asyncio.run(main())
