import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve('.');
const runDir = join(root, '.artifacts', 'packaged-cu-stop-visual');
const profile = join(runDir, 'profile');
const dataDir = join(runDir, 'data');
const title = `PI-CU-STOP-${randomUUID()}`;
const fixturePath = join(runDir, 'fixture.ps1');
const statePath = join(runDir, 'state.txt');
const clickedStatePath = join(runDir, 'clicked.txt');
const exe = join(root, 'apps/desktop/release/win-unpacked/PI-Desktop.exe');
const debugPort = await reservePort();
if (!existsSync(exe)) throw new Error(`Packaged app missing: ${exe}; build it first.`);
async function reservePort() { const reservation=createServer(); await new Promise((resolve,reject)=>{reservation.once('error',reject);reservation.listen(0,'127.0.0.1',resolve);}); const port=reservation.address().port; await new Promise((resolve)=>reservation.close(resolve)); return port; }
let app, fixtureProc, server, sockets = [];
let mainRequests = 0, computerRequests = 0, computerImages = 0, switchReplies = 0, finalReplies = 0;
let stalled = false;
let aborted = false;
let clickReplyIssued = false;
const endpointReady = new Promise((resolve, reject) => {
  server = createServer(async (req, res) => {
    let body;
    try { const chunks=[]; for await (const chunk of req) chunks.push(chunk); body=JSON.parse(Buffer.concat(chunks).toString()); }
    catch (error) { res.writeHead(400).end(String(error)); return; }
    const isComputer = body.model === 'deepseek-flash';
    let delta, finish;
    if (isComputer) {
      computerRequests++;
      const messages = body.messages ?? [];
      const text = messages.map((item) => typeof item.content === 'string' ? item.content : Array.isArray(item.content) ? item.content.map((part) => part.type === 'text' ? part.text : '').join('\n') : '').join('\n');
      if (messages.some((item) => Array.isArray(item.content) && item.content.some((part) => part.type === 'image_url' && String(part.image_url?.url ?? '').startsWith('data:image/png;base64,')))) computerImages++;
      const currentLine = text.split(/\r?\n/).find((line) => line.startsWith('Current window:')) ?? '';
      if (!currentLine.includes(title)) {
        const targetLine = text.split(/\r?\n/).find((line) => line.includes(title) && line.includes('window_id='));
        const window = targetLine?.match(/window_id="([^"]+)"/)?.[1];
        if (!window) { res.writeHead(500).end('fixture window id missing'); return; }
        switchReplies++;
        delta={role:'assistant',content:JSON.stringify({kind:'switch',window,note:'Select isolated fixture window'})}; finish='stop';
      } else if (!clickReplyIssued) {
        const actionLine=text.split(/\r?\n/).find((line)=>line.includes('CU-STOP-ACTION')&&line.includes('uid='));
        const uid=actionLine?.match(/\buid=([^\s·]+)/)?.[1];
        if(!uid){res.writeHead(500).end('isolated fixture action UID missing');return;}
        clickReplyIssued=true;
        delta={role:'assistant',content:JSON.stringify({kind:'action',action:{kind:'click',uid}})};finish='stop';
      } else {
        res.on('close', () => { aborted=true; });
        req.on('aborted', () => { aborted=true; });
        stalled=true;
        return; // Hold the Computer model response until Stop cancels this exact run.
      }
    } else {
      mainRequests++;
      const tools=body.tools ?? [];
      const messages=body.messages ?? [];
      const lastUser=messages.findLastIndex((item) => item.role === 'user');
      const tail=messages.slice(lastUser + 1);
      const hasToolResult=tail.some((item) => item.role === 'tool' || item.tool_call_id);
      if (tools.some((item) => item.function?.name === 'Computer') && !hasToolResult) {
        delta={role:'assistant',tool_calls:[{index:0,id:'stop-test-call',type:'function',function:{name:'Computer',arguments:JSON.stringify({instruction:`Switch to ${title} and wait for the next instruction.`})}}]}; finish='tool_calls';
      } else { finalReplies++; delta={role:'assistant',content:'Computer Use stopped by the test.'}; finish='stop'; }
    }
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
    res.end(`data: ${JSON.stringify({id:'local-fixture',model:body.model,choices:[{index:0,delta,finish_reason:null}]})}\n\n`+`data: ${JSON.stringify({id:'local-fixture',model:body.model,choices:[{index:0,delta:{},finish_reason:finish}]})}\n\n`+'data: [DONE]\n\n');
  });
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/v1`));
});
const endpoint=await endpointReady;
const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
const getTargets=async()=>{try{return await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();}catch{return[];}};
async function waitFor(fn, label, timeout=30000) { const end=Date.now()+timeout; while(Date.now()<end){ const value=await fn(); if(value) return value; await sleep(150); } throw new Error(`${label} timeout`); }
async function connect(target) {
  const ws=new WebSocket(target.webSocketDebuggerUrl); sockets.push(ws);
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
  let nextId=0; const pending=new Map();
  ws.onmessage=(event)=>{const msg=JSON.parse(event.data);const p=pending.get(msg.id);if(!p)return;pending.delete(msg.id);msg.error?p.reject(Error(msg.error.message)):p.resolve(msg.result);};
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++nextId;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  return {send,eval:async(expression)=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result?.value;}};
}
const unwrap=(response, label)=>{if(!response?.ok)throw Error(`${label} failed`);return response.data;};
async function invoke(c,name,input) { const channel=await c.eval(`window.piDesktop.channels.invoke.${name}`); return unwrap(await c.eval(`(async()=>window.piDesktop.invoke(${JSON.stringify(channel)}${input===undefined?'':','+JSON.stringify(input)}))()`),name); }
try {
  await mkdir(runDir,{recursive:true});
  const safeStatePath=statePath.replaceAll("'","''");
  const safeClickedStatePath=clickedStatePath.replaceAll("'","''");
  await writeFile(fixturePath,`Add-Type -AssemblyName System.Windows.Forms\n$screen=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;$w=[Math]::Min(1000,$screen.Width);$h=[Math]::Min(700,$screen.Height)\n$form=New-Object System.Windows.Forms.Form;$form.Text='${title}';$form.FormBorderStyle='None';$form.StartPosition='Manual';$form.Location=New-Object System.Drawing.Point -ArgumentList $screen.X,$screen.Y;$form.Size=New-Object System.Drawing.Size -ArgumentList $w,$h;$form.BackColor=[System.Drawing.Color]::FromArgb(0,175,95);$form.TopMost=$false\n[IO.File]::WriteAllText('${safeStatePath}',($screen.X.ToString()+','+$screen.Y.ToString()+','+$w.ToString()+','+$h.ToString()))\n$label=New-Object System.Windows.Forms.Label;$label.Text='Isolated stop test';$label.Location=New-Object System.Drawing.Point(30,30);$label.AutoSize=$true\n$button=New-Object System.Windows.Forms.Button;$button.AccessibleName='CU-STOP-ACTION';$button.Text='Test target';$button.Location=New-Object System.Drawing.Point(30,70);$button.add_Click({$label.Text='CU-STOP-CLICKED';[IO.File]::WriteAllText('${safeClickedStatePath}','clicked')})\n$form.Controls.Add($label);$form.Controls.Add($button);[System.Windows.Forms.Application]::Run($form)`);
  fixtureProc=spawn('powershell.exe',['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',fixturePath],{stdio:'ignore'}); await sleep(900);
  app=spawn(exe,[`--user-data-dir=${profile}`,`--remote-debugging-port=${debugPort}`],{env:{...process.env,PI_DESKTOP_DATA_DIR:dataDir,NO_PROXY:'127.0.0.1,localhost',no_proxy:'127.0.0.1,localhost'},stdio:'ignore'});
  const mainTarget=await waitFor(async()=> (await getTargets()).find((target)=>target.type==='page' && target.url.includes('/renderer/index.html') && !target.url.includes('surface=')), 'main renderer');
  const main=await connect(mainTarget);
  const chat=unwrap(await main.eval(`window.piDesktop.invoke(window.piDesktop.channels.invoke.providersCreate,${JSON.stringify({name:'CU Stop E2E chat',type:'openai_compatible',protocol:'openai_compatible',authKind:'none',baseUrl:endpoint,defaultModelId:'deepseek-v4-pro',apiStyle:'chat_completions'})})`),'create chat provider');
  const computer=unwrap(await main.eval(`window.piDesktop.invoke(window.piDesktop.channels.invoke.providersCreate,${JSON.stringify({name:'CU Stop E2E computer',type:'openai_compatible',protocol:'openai_compatible',authKind:'none',baseUrl:endpoint,defaultModelId:'deepseek-flash',apiStyle:'chat_completions'})})`),'create Computer provider');
  let settings=await invoke(main,'settingsGet');
  settings={...settings,defaultProviderId:chat.provider.id,defaultModelId:'deepseek-v4-pro',defaultMode:'agent',defaultPermissionMode:'auto',computerUse:{enabled:true,model:{providerId:computer.provider.id,modelId:'deepseek-flash'},defaultInputPolicy:'autonomous-in-scope',defaultCapture:'a11y-and-pixels',actionBudget:12,idleExpiryMs:90000}};
  await invoke(main,'settingsSet',settings);
  const session=unwrap(await main.eval(`window.piDesktop.invoke(window.piDesktop.channels.invoke.sessionCreate,${JSON.stringify({title:'CU Stop E2E',mode:'agent',projectPath:runDir,providerId:chat.provider.id,modelId:'deepseek-v4-pro',permissionMode:'auto'})})`),'create session');
  const activate=spawnSync('powershell.exe',['-NoProfile','-Command',`$s=New-Object -ComObject WScript.Shell;if(-not $s.AppActivate(${app.pid})){exit 2};'ok'`],{encoding:'utf8',windowsHide:true});
  assert.equal(activate.status,0,'could not make the PI app the initial foreground window');
  await invoke(main,'agentPrompt',{sessionId:session.session.id,content:`Select the isolated test window ${title}; keep waiting for the next instruction.`,messageId:randomUUID(),viewingSessionId:session.session.id,permissionMode:'auto'});
  await waitFor(()=>Promise.resolve(stalled ? true : null), 'Computer model stall');
  const fixtureState=await waitFor(async()=>{try{return (await readFile(clickedStatePath,'utf8')).trim()==='clicked'?'clicked':null;}catch{return null;}},'native fixture click postcondition',5000);
  assert.equal(fixtureState,'clicked','Host dispatch must cause the fixture button handler to run before Stop is tested');
  const targets=await waitFor(async()=>{const current=await getTargets();return current.some((target)=>target.type==='page'&&target.url.includes('surface=computer-use-widget'))&&current.some((target)=>target.type==='page'&&target.url.includes('surface=computer-use-cursor'))?current:null;},'widget and cursor surfaces');
  const widgetTarget=targets.find((target)=>target.type==='page'&&target.url.includes('surface=computer-use-widget'));
  const cursorTarget=targets.find((target)=>target.type==='page'&&target.url.includes('surface=computer-use-cursor'));
  const widget=await connect(widgetTarget), cursor=await connect(cursorTarget);
  const widgetState=await waitFor(async()=>{const value=await widget.eval(`(()=>{const root=document.querySelector('.computer-use-widget');const stop=document.querySelector('.computer-use-widget-stop');return root&&stop?{text:root.innerText,disabled:stop.disabled}:null})()`);return value&&value.text.includes(title)?value:null;},'visible status widget with fixture target');
  const cursorState=await waitFor(async()=>await cursor.eval(`(()=>{const root=document.querySelector('.computer-cursor-surface');const style=root&&getComputedStyle(root,'::after');return root&&style?{border:style.border,boxShadow:style.boxShadow,position:getComputedStyle(root).position}:null})()`),'cursor overlay');
  assert.match(cursorState.boxShadow,/96px|160px|240px/i,'screen-edge effect not present in cursor overlay style');
  assert.equal(widgetState.disabled,false,'Stop must be enabled during a live Computer call');
  let desktopComposite;
  if (process.env.PI_CU_E2E_VERIFY_DESKTOP_COMPOSITE === '1') {
    await sleep(250); // Let DWM finish the foreground-window transition after the exact target switch.
    const [screenX,screenY,width,height]= (await readFile(statePath,'utf8')).split(',').map(Number);
    const edgeX=screenX+40, sampleY=screenY+Math.min(350,height-20), centerX=screenX+Math.min(750,width-20);
    const pixelScript=`Add-Type -AssemblyName System.Drawing;Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class CUWin32{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint processId);}';$foregroundPid=0;[void][CUWin32]::GetWindowThreadProcessId([CUWin32]::GetForegroundWindow(),[ref]$foregroundPid);$bitmap=New-Object System.Drawing.Bitmap(1,1);$graphics=[System.Drawing.Graphics]::FromImage($bitmap);$graphics.CopyFromScreen(${edgeX},${sampleY},0,0,$bitmap.Size);$edge=$bitmap.GetPixel(0,0);$graphics.CopyFromScreen(${centerX},${sampleY},0,0,$bitmap.Size);$center=$bitmap.GetPixel(0,0);$graphics.Dispose();$bitmap.Dispose();@{foregroundMatches=($foregroundPid -eq ${fixtureProc.pid});edge=@{r=$edge.R;g=$edge.G;b=$edge.B};center=@{r=$center.R;g=$center.G;b=$center.B}}|ConvertTo-Json -Compress`;
    const sampled=spawnSync('powershell.exe',['-NoProfile','-STA','-Command',pixelScript],{encoding:'utf8',windowsHide:true});
    assert.equal(sampled.status,0,'desktop pixel sampling failed');
    const pixels=JSON.parse(sampled.stdout.trim());
    const centerVisible=pixels.foregroundMatches&&pixels.center.g>100&&pixels.center.r<100&&pixels.center.b<160;
    const edgeBlueTint=pixels.edge.b>pixels.center.b+20;
    assert(centerVisible,`the isolated fixture color is not visible through the overlay center: ${JSON.stringify(pixels)}`);
    assert(edgeBlueTint,`the blue edge glow did not alter the known fixture color near the display edge: ${JSON.stringify(pixels)}`);
    desktopComposite={centerVisible,edgeBlueTint};
  }
  if (process.env.PI_CU_E2E_CAPTURE_PREVIEW === '1') {
    const viewport = await cursor.eval('({width:innerWidth,height:innerHeight})');
    const preview = await cursor.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false,clip:{x:0,y:0,width:viewport.width,height:viewport.height,scale:0.25}});
    console.log(`CURSOR_OVERLAY_PREVIEW_BASE64:${preview.data}`);
  }
  await widget.eval(`document.querySelector('.computer-use-widget-stop').click()`);
  await waitFor(()=>Promise.resolve(aborted ? true : null), 'aborted Computer model request',10000);
  await waitFor(async()=>{try{const result=await invoke(main,'computerGrantDescribe');return result.grant===null;}catch{return false;}},'revoked Host grant',10000);
  const widgetAfterStop=await waitFor(async()=>{const v=await widget.eval(`(()=>({stop:!!document.querySelector('.computer-use-widget-stop'),text:document.body.innerText}))()`);return v&&!v.stop&&!v.text.includes(title)?v:null;},'status widget cleared after Stop',10000);
  assert.equal(switchReplies,1); assert(computerImages>=2); assert(clickReplyIssued); assert.equal(finalReplies,0); assert(aborted);
  console.log('PACKAGED STOP/CURSOR E2E PASS',JSON.stringify({switchReplies,computerRequests,computerImages,fixtureStateConfirmed:fixtureState==='clicked',widgetVisible:widgetState.text.includes(title),stopEnabled:!widgetState.disabled,widgetCleared:!widgetAfterStop.stop&&!widgetAfterStop.text.includes(title),cursorBorder:cursorState.border,cursorEdgeGlow:cursorState.boxShadow.includes('96px')||cursorState.boxShadow.includes('160px'),desktopComposite,aborted,finalReplies,screenshotsSaved:0}));
} catch(error) { console.error('PACKAGED STOP/CURSOR E2E FAIL',JSON.stringify({mainRequests,computerRequests,computerImages,switchReplies,finalReplies,aborted,error:String(error)})); throw error; }
finally {
  for(const ws of sockets)try{ws.close()}catch{}
  try{server.close()}catch{}
  for(const child of [app,fixtureProc])if(child?.pid){const proc=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});await new Promise((resolve)=>{proc.once('close',resolve);setTimeout(resolve,3000);});}
  await rm(runDir,{recursive:true,force:true}).catch(()=>{});
  await rmdir(join(root,'.artifacts')).catch(()=>{});
}
