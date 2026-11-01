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
        pa=await open_page(A,errs); await pa.goto(U)
        await pa.evaluate("""()=>localStorage.setItem('malysh.v1',JSON.stringify({profile:{name:'',birth:''},events:[{id:'e1',type:'bottle',start:Date.now()-36e5,ml:100,kind:'formula'}],growth:[],vacc:{done:{},custom:[]},solids:{},solidsCustom:[],timers:{}}))""")
        await pa.reload(); await pa.wait_for_timeout(200)
        await pa.click('[data-act=settings]'); await pa.click('[data-x=sync-create]'); await pa.wait_for_timeout(800); await pa.keyboard.press('Escape')
        code=await pa.evaluate('Sync.family')
        pb=await open_page(B,errs); await pb.goto(U); await pb.wait_for_timeout(200)
        await pb.click('[data-act=settings]'); await pb.fill('[name=joincode]',code); await pb.click('[data-x=sync-join]'); await pb.wait_for_timeout(1000); await pb.keyboard.press('Escape')
        # Оба телефона перезапускаются — теперь подписка «только изменения» (как у вас сейчас)
        await pa.close(); pa=await open_page(A,errs); await pa.goto(U); await pa.wait_for_timeout(1200)
        await pb.close(); pb=await open_page(B,errs); await pb.goto(U); await pb.wait_for_timeout(1200)
        # Мама вписывает имя и дату рождения
        await pa.click('[data-act=settings]'); await pa.fill('[name=name]','Миша'); await pa.fill('[name=birth]','2026-05-10')
        await pa.click('.sheet footer .btn.primary'); await pa.wait_for_timeout(1500)
        sa,sb=await S(pa),await S(pb)
        ok(sa['profile']['name']=='Миша' and sa['profile']['birth']=='2026-05-10', f'1) профиль сохранился у мамы: {sa["profile"].get("name")!r} {sa["profile"].get("birth")!r}')
        ok(sb['profile']['name']=='Миша', f'1) профиль дошёл до папы: {sb["profile"].get("name")!r}')
        # Второе сохранение в течение 10 минут (меняем имя ещё раз)
        await pa.click('[data-act=settings]'); await pa.fill('[name=name]','Михаил'); await pa.click('.sheet footer .btn.primary'); await pa.wait_for_timeout(1500)
        sa,sb=await S(pa),await S(pb)
        ok(sa['profile']['name']=='Михаил' and sb['profile']['name']=='Михаил', f'2) повторная правка профиля: мама {sa["profile"].get("name")!r}, папа {sb["profile"].get("name")!r}')
        # Правка свежей записи дважды подряд не должна её удалить
        await pb.evaluate("()=>{S.events.push({id:'fresh',type:'bottle',start:Date.now(),ml:120,kind:'formula'});save();}"); await pb.wait_for_timeout(800)
        await pb.evaluate("()=>{S.events.find(e=>e.id==='fresh').ml=150;save();}"); await pb.wait_for_timeout(800)
        await pb.evaluate("()=>{S.events.find(e=>e.id==='fresh').ml=180;save();}"); await pb.wait_for_timeout(1200)
        sa,sb=await S(pa),await S(pb)
        fa=[e for e in sa['events'] if e['id']=='fresh']; fb=[e for e in sb['events'] if e['id']=='fresh']
        ok(fa and fb and fa[0]['ml']==180 and fb[0]['ml']==180, f'3) свежая запись после двух правок цела: у мамы {fa[0]["ml"] if fa else "нет"}, у папы {fb[0]["ml"] if fb else "нет"}')
        # Сон: «Уснул» и через минуту «Проснулся»
        await pa.goto(U+'#today'); await pa.wait_for_timeout(300)
        await pa.click('.sleep-card [data-act=sleep-toggle]'); await pa.wait_for_timeout(800)
        await pa.evaluate("()=>{S.timers.sleep.start-=5*6e4;save();}"); await pa.wait_for_timeout(800)
        await pa.click('.sleep-card [data-act=sleep-toggle]'); await pa.wait_for_timeout(1500)
        sa,sb=await S(pa),await S(pb)
        ok(len(ev_ids(sa,'sleep'))==1 and ev_ids(sa,'sleep')==ev_ids(sb,'sleep') and not sb['timers'].get('sleep'), f'4) сон записан у обоих: {ev_ids(sa,"sleep")} / {ev_ids(sb,"sleep")}')
        ok(sa['profile']['name']=='Михаил' and sb['profile']['name']=='Михаил', '5) профиль после всего этого на месте у обоих')
        # 6) Быстрые правки подряд без пауз
        await pb.evaluate("()=>{const e=S.events.find(x=>x.id==='fresh');e.ml=200;save();e.ml=210;save();e.ml=220;save();}"); await pb.wait_for_timeout(2000)
        sa,sb=await S(pa),await S(pb)
        fa=[e for e in sa['events'] if e['id']=='fresh']; fb=[e for e in sb['events'] if e['id']=='fresh']
        ok(fa and fb and fa[0]['ml']==220 and fb[0]['ml']==220, f'6) три быстрые правки подряд: у мамы {fa[0]["ml"] if fa else "нет"}, у папы {fb[0]["ml"] if fb else "нет"}')
        await pa.goto(U+'#today'); await pa.wait_for_timeout(300)
        await pa.click('.sleep-card [data-act=sleep-toggle]'); await pa.wait_for_timeout(150)
        await pa.evaluate("()=>{delete S.timers.sleep;save();render();}"); await pa.wait_for_timeout(2000)
        sa,sb=await S(pa),await S(pb)
        ok(not sa['timers'].get('sleep') and not sb['timers'].get('sleep'), f'7) «Уснул» и сразу «Отмена»: таймера нет ни у кого (мама {bool(sa["timers"].get("sleep"))}, папа {bool(sb["timers"].get("sleep"))})')
        print('errors',errs); await b.close()
asyncio.run(main())
