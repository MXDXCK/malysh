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
        await pa.evaluate("""()=>localStorage.setItem('malysh.v1',JSON.stringify({profile:{name:'Каролина',birth:'2026-05-17'},events:[],growth:[],vacc:{done:{},custom:[]},solids:{},solidsCustom:[],timers:{}}))""")
        await pa.reload(); await pa.wait_for_timeout(200)
        await pa.click('[data-act=settings]'); await pa.click('[data-x=sync-create]'); await pa.wait_for_timeout(800); await pa.keyboard.press('Escape')
        code=await pa.evaluate('Sync.family')
        pb=await open_page(B,errs); await pb.goto(U); await pb.wait_for_timeout(200)
        await pb.click('[data-act=settings]'); await pb.fill('[name=joincode]',code); await pb.click('[data-x=sync-join]'); await pb.wait_for_timeout(1000); await pb.keyboard.press('Escape')
        await pa.close(); pa=await open_page(A,errs); await pa.goto(U); await pa.wait_for_timeout(1000)
        await pb.close(); pb=await open_page(B,errs); await pb.goto(U); await pb.wait_for_timeout(1000)
        # Папа нажал «Уснул»
        await pa.click('.sleep-card [data-act=sleep-toggle]'); await pa.wait_for_timeout(1000)
        start0=await pa.evaluate('S.timers.sleep.start')
        # Мама нажимает на карточку таймера → «15 мин назад» → «Ночной» → Сохранить
        await pb.goto(U+'#today'); await pb.wait_for_timeout(300)
        await pb.click('.sleep-now .sn-btns [data-act=edit-live]'); await pb.wait_for_timeout(200)
        await pb.screenshot(path='/tmp/live-form.png')
        await pb.click('[data-ago="15"]'); await pb.click('.seg label:has-text("Ночной")'); await pb.click('.sheet footer .btn.primary'); await pb.wait_for_timeout(1200)
        ta,tb=await pa.evaluate('S.timers.sleep'),await pb.evaluate('S.timers.sleep')
        ok(ta and tb and ta['start']==tb['start'] and start0-ta['start']>=14*60000 and ta['kind']=='night', f"1) «Уснул» сдвинут на {round((start0-ta['start'])/60000)} мин раньше и стал ночным — у обоих")
        await pa.goto(U+'#today'); await pa.wait_for_timeout(300)
        await pa.locator('.sleep-card').screenshot(path='/tmp/live-card.png')
        # Плашка идущего сна тоже открывает правку; указываем «Проснулся»
        await pa.click('.tile.live'); await pa.wait_for_timeout(200)
        ok(await pa.locator('dialog[open] h2').inner_text()=='Идущий сон', '2) нажатие на плашку идущего сна открывает правку')
        await pa.evaluate("()=>{const f=document.querySelector('[name=end]');const d=new Date(Date.now()-60000);const p=n=>String(n).padStart(2,'0');f.value=d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes());}")
        await pa.click('.sheet footer .btn.primary'); await pa.wait_for_timeout(1200)
        sa,sb=await S(pa),await S(pb)
        ok(not sa['timers'].get('sleep') and not sb['timers'].get('sleep') and ev_ids(sa,'sleep')==ev_ids(sb,'sleep') and len(ev_ids(sa,'sleep'))==1, f"3) «Проснулся» через правку: сон записан у обоих {ev_ids(sa,'sleep')}, таймеров нет")
        e=[x for x in sa['events'] if x['type']=='sleep'][0]
        ok(e['kind']=='night' and e['start']==ta['start'], '4) записан ночной сон с исправленным временем «Уснул»')
        # Время в будущем не принимается
        await pa.click('.sleep-card [data-act=sleep-toggle]'); await pa.wait_for_timeout(500)
        await pa.click('.sleep-now .sn-btns [data-act=edit-live]'); await pa.evaluate("document.querySelector('[name=start]').removeAttribute('max');document.querySelector('[name=start]').value='2030-01-01T10:00'")
        await pa.click('.sheet footer .btn.primary'); await pa.wait_for_timeout(300)
        ok(await pa.locator('dialog[open]').count()==1, '5) время «Уснул» в будущем не сохраняется')
        print('errors',errs); await b.close()
asyncio.run(main())
