import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Preview only: fixed pixel grids, directly expressible as colored terminal half-blocks.
const variants = [
  {
    id: 'A',
    name: '小火山',
    detail: '紧凑、轮廓清楚 · 适合常驻顶栏',
    grid: [
      '      a       ',
      '   a     h    ',
      '     aah      ',
      '    ahhhaa    ',
      '   hkrhkrha   ',
      '  hrkkkkkkrh  ',
      ' arkkwkkwkkrh ',
      ' hrkkwkkwkkra ',
      'arkkkkkkkkkkra',
      ' aarrkkrrraa  ',
    ],
  },
  {
    id: 'B',
    name: '迷你火山',
    detail: '更小、更安静 · 给对话多留空间',
    grid: [
      '     a      ',
      '   a   h    ',
      '    ahha    ',
      '   hkhkha   ',
      '  hrkkkkrh  ',
      ' arkwkkwkra ',
      'arkkkkkkkkra',
      ' aarrkrraa  ',
    ],
  },
  {
    id: 'C',
    name: '岩岩',
    detail: '岩体更饱满 · 更接近参考图的角色感',
    grid: [
      '        h         ',
      '    a      a      ',
      '      aahha       ',
      '     ahhhhhha     ',
      '    hrhkrkhrha    ',
      '   hrkkkkkkkkrh   ',
      '  hrkkwkkkwkkkrh  ',
      ' arkkkwkkkwkkkkrh ',
      'hrkkkkkkkkkkkkkkra',
      ' aarrkkrrkkrrraa  ',
    ],
  },
];
const directory = resolve('../artifacts/brand');
await mkdir(directory, { recursive: true });
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>涌现 · 火山兽候选</title><style>
:root{color-scheme:dark;--canvas:#111213;--text:#e1e1df;--muted:#989a9a;--line:#303234;--warm:#efb663}*{box-sizing:border-box}body{margin:0;background:#0d0e0f;color:var(--text);font:14px/1.6 system-ui,"Microsoft YaHei UI",sans-serif}main{max-width:1200px;padding:32px 28px 40px;margin:auto}header.top{display:flex;justify-content:space-between;gap:20px;align-items:center}h1{font-size:23px;font-weight:550;letter-spacing:.02em;margin:4px 0 6px}p{margin:0;color:var(--muted)}.eyebrow{font-size:11px;letter-spacing:.18em;color:#aaa}.badge{font-size:12px;color:#b7b7b3;border:1px solid #343638;border-radius:5px;padding:4px 10px;white-space:nowrap}.options{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:26px 0 24px}.option{font:inherit;text-align:left;color:inherit;background:#151617;border:1px solid #303234;border-radius:8px;padding:16px 18px;cursor:pointer}.option:hover{border-color:#777}.option[aria-pressed=true]{border-color:#b8b4ab;background:#1b1c1d}.optionhead{display:flex;align-items:center;justify-content:space-between}.letter{font:600 12px ui-monospace,Consolas,monospace;color:#c9c9c5}.choice{font-size:11px;color:#c9c9c5}.sample{height:104px;display:flex;align-items:center;gap:17px}.sample strong{font:600 13px Consolas,monospace}.option p{font-size:12px}.sprite{flex:none;display:block;overflow:visible;shape-rendering:crispEdges}.bar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:12px}.bar label{font-size:13px;color:#aaa}.controls{display:flex;flex-wrap:wrap;gap:6px}button.control{font:inherit;font-size:12px;padding:5px 11px;color:#a8aaa9;background:#18191a;border:1px solid #303234;border-radius:4px;cursor:pointer}button.control[aria-pressed=true]{color:#f1e9da;border-color:#8c795e;background:#24201b}button:focus-visible{outline:2px solid #e0c495;outline-offset:3px}.terminal{background:#101112;border:1px solid #383a3b;border-radius:8px;overflow:hidden;font:14px/1.7 "Cascadia Mono",Consolas,"Microsoft YaHei UI",monospace}.titlebar{padding:9px 18px;background:#191b1c;border-bottom:1px solid #282a2c;font-size:12px;color:#9a9d9e;display:flex;justify-content:space-between}.canvas{padding:20px 22px 18px}.brandrow{display:flex;gap:20px;align-items:center;min-height:88px}.brandrow strong{font-size:16px;color:#e9e9e6}.meta{font-size:12px;color:#999d9f;margin-top:4px}.status{margin-left:auto;color:#b3b5b4;font-size:12px;align-self:flex-start;padding-top:7px}.tabs{font-size:12px;padding:13px 0 14px;color:#7d8082;border-bottom:1px solid #292b2d}.tabs b{font-weight:500;color:#e1e2de}.conversation{padding:25px 0 20px;min-height:255px;max-width:860px}.user{background:#232526;border-left:2px solid #989a98;color:#b8bab7;padding:9px 14px;margin-bottom:25px}.role{font-size:11px;color:#999e9e;margin-bottom:3px}.assistant{padding-left:16px}.assistant .role{color:#dadcd8;font-weight:600}.assistant p{color:#d9dbd8;margin:8px 0}.assistant ul{margin:10px 0;padding-left:20px;color:#c2c5c2}.composer{margin-top:8px;background:#1c1e1f;min-height:54px;padding:12px 14px;color:#898d8e;border:1px solid #303234}.foot{display:flex;gap:20px;justify-content:space-between;font-size:11px;color:#808588;padding-top:13px}.note{font-size:12px;margin-top:16px;color:#8d9292}.reference{color:#afb3b0}.statehint{color:#b9afa1;min-height:22px;font-size:12px;margin-top:9px}.recommend{font-size:11px;color:#bbb6aa;margin-left:8px}@media(max-width:740px){main{padding:22px 16px}.options{grid-template-columns:1fr}.sample{height:92px}.bar{align-items:flex-start;flex-direction:column}.top .badge{display:none}.canvas{padding:16px}.status{display:none}.brandrow{gap:14px}.foot{flex-wrap:wrap;gap:2px}.terminal{font-size:12px}}
</style><main><header class="top"><div><div class="eyebrow">EMERGENCE / CHARACTER STUDIES</div><h1>顶栏里的小火山</h1><p>首页沿用书法「涌现」。进入对话后，让它陪在英文名称旁边。</p></div><span class="badge">候选预览 · 待你选择</span></header><div class="options" id="options"></div><div class="bar"><label id="selection">A · 小火山 / 对话页预览</label><div class="controls" id="controls"><button class="control" data-state="idle" aria-pressed="true">等待输入</button><button class="control" data-state="thinking" aria-pressed="false">思考中</button><button class="control" data-state="tool" aria-pressed="false">调用工具</button><button class="control" data-state="done" aria-pressed="false">完成</button><button class="control" data-state="error" aria-pressed="false">错误</button><button class="control" id="motion" aria-pressed="false">暂停动效</button></div></div><div class="terminal"><div class="titlebar"><span>Emergence</span><span>对话工作台</span></div><div class="canvas"><div class="brandrow"><div id="hero"></div><div><strong>Emergence</strong><div class="meta">独立模式 · 1 会话</div><div class="meta">deepseek / deepseek-flash</div></div><div class="status" id="status">○ 就绪</div></div><div class="tabs"><b>› 1 会话 · 涌现TUI</b>　　＋ 新会话</div><div class="conversation"><div class="user"><div class="role">你</div>帮我看看这个项目接下来可以优化什么。</div><div class="assistant"><div class="role">涌现</div><p>可以，我会先了解项目，再整理具体的调整建议。</p><ul><li>梳理当前功能与主要使用流程</li><li>检查界面的信息层级和交互反馈</li><li>列出改动范围与验证方式</li></ul></div></div><div class="composer">继续描述你想完成的工作…</div><div class="foot"><span>Enter 发送　·　Shift+Enter 换行　·　/ 命令</span><span>Ctrl+C 两次退出</span></div></div></div><div class="statehint" id="statehint">待机：偶尔眨眼，火星轻缓变化。</div><p class="note">点击上方 A / B / C 比较尺寸与外形，再切换状态看动效。<span class="reference">颜色取自参考方向：炭黑岩体、暖橙熔岩、米白眼睛。</span> 本页状态为演示，尚未接入实际 TUI。</p></main><script>
const variants=${JSON.stringify(variants)};
const palette={a:'#f49a35',h:'#ffd081',w:'#f6e7c6',r:'#303739',k:'#171c1e'};
let selected=0,state='idle',tick=0,paused=matchMedia('(prefers-reduced-motion: reduce)').matches;
const descriptions={idle:'待机：偶尔眨眼，火星轻缓变化。',thinking:'思考：火口更亮，少量火星向上跳动；身体保持稳定。',tool:'工具：上方出现小提示，等待执行结果。',done:'完成：短暂闪出火星，随后回到安静状态。',error:'错误：火口变为暗朱红，保留清楚的眼睛与轮廓。'};
const statuses={idle:'○ 就绪',thinking:'● 思考中',tool:'◇ 正在调用工具',done:'✓ 已完成',error:'× 需要处理'};
function sprite(v,step=0,mode='idle',pixel=6){
const rows=v.grid.map(r=>r.split('')),width=Math.max(...rows.map(r=>r.length)),height=rows.length;
const blink=mode==='idle'&&step%20===19;
let out='';
for(let y=0;y<height;y++)for(let x=0;x<rows[y].length;x++){
 let c=rows[y][x];if(c===' ')continue;
 if(y<2){if(mode==='tool')continue;if(mode==='idle'&&((x+step)%4===0))continue;if(mode==='thinking'&&((x+step)%3===0))continue;if(mode==='done'&&step>4)continue;}
 if(blink&&c==='w'&&rows[y+1]?.[x]==='w')c='k';
 let color=palette[c];if(mode==='error'&&(c==='a'||c==='h'))color=c==='a'?'#cb573e':'#e88655';
 if(mode==='thinking'&&c==='a'&&y>=2&&y<=3&&step%2)color='#ffc064';
 const dy=y<2&&mode==='thinking'?(step%2?-.35:0):0;
 out+='<rect x="'+x+'" y="'+(y+dy)+'" width="1" height="1" fill="'+color+'"/>';
}
if(mode==='tool'){out+='<path d="M'+(width/2)+' .1v.8m0 .55v.2" stroke="#f6e7c6" stroke-width=".7"/>';}
return '<svg class="sprite" role="img" aria-label="像素火山兽：'+v.name+'" width="'+width*pixel+'" height="'+height*pixel+'" viewBox="0 0 '+width+' '+height+'" xmlns="http://www.w3.org/2000/svg">'+out+'</svg>';
}
const options=document.getElementById('options');
options.innerHTML=variants.map((v,i)=>'<button class="option" data-option="'+i+'" aria-pressed="'+(i===0)+'"><div class="optionhead"><span class="letter">'+v.id+' / '+v.name+(i===0?'<span class="recommend">建议先看</span>':'')+'</span><span class="choice">'+(i===0?'正在预览':'查看此版')+'</span></div><div class="sample">'+sprite(v,0,'idle',5)+'<strong>Emergence</strong></div><p>'+v.detail+'</p></button>').join('');
function render(){document.getElementById('hero').innerHTML=sprite(variants[selected],paused?0:tick,state,6);document.getElementById('status').textContent=statuses[state];document.getElementById('statehint').textContent=descriptions[state];}
options.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;selected=Number(b.dataset.option);tick=0;document.querySelectorAll('.option').forEach((b,i)=>{b.setAttribute('aria-pressed',String(i===selected));b.querySelector('.choice').textContent=i===selected?'正在预览':'查看此版'});document.getElementById('selection').textContent=variants[selected].id+' · '+variants[selected].name+' / 对话页预览';render()});
document.querySelectorAll('[data-state]').forEach(b=>b.onclick=()=>{state=b.dataset.state;tick=0;document.querySelectorAll('[data-state]').forEach(t=>t.setAttribute('aria-pressed',String(t===b)));render()});
const motion=document.getElementById('motion');function setMotion(){motion.textContent=paused?'播放动效':'暂停动效';motion.setAttribute('aria-pressed',String(paused));render()};motion.onclick=()=>{paused=!paused;setMotion()};setMotion();setInterval(()=>{if(paused||document.hidden)return;tick++;render()},450);
</script></html>`;
await writeFile(resolve(directory, 'volcano-preview.html'), html);
console.log(resolve(directory, 'volcano-preview.html'));
