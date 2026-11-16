import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { aggregatePixels, type AggregateState } from '../src/app/tui/aggregate-brand.ts';

const states: AggregateState[] = ['idle', 'thinking', 'tool', 'done', 'error'];
const frames = Object.fromEntries(
  states.map((state) => [
    state,
    Array.from({ length: 20 }, (_, tick) => aggregatePixels(state, tick, '#111111')),
  ]),
);
await writeFile(
  resolve('../artifacts/brand/aggregate-preview.html'),
  `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>涌现 · 聚合标记</title><style>
*{box-sizing:border-box}body{margin:0;background:#111;color:#ddd;font:14px/1.7 Consolas,'Microsoft YaHei UI',monospace}main{max-width:1100px;margin:auto;padding:32px}h1{font-size:18px}p{color:#999}.brand{display:flex;align-items:center;gap:18px;margin:28px 0}.mark{width:64px;height:48px;display:grid;grid-template-columns:repeat(16,1fr);grid-template-rows:repeat(6,1fr)}.meta{line-height:16px;color:#999}.meta b{color:#eee}button{background:#1c1c1c;color:#bbb;border:1px solid #444;padding:7px 15px;margin:0 8px 8px 0;cursor:pointer}button[aria-pressed=true]{color:white;border-color:#aaa}iframe{width:100%;height:800px;border:1px solid #333;margin-top:24px}</style><main><h1>白色聚合标记</h1><p>与终端相同的像素与动画帧 · 主体稳定，仅右上圆点变化</p><div class="brand"><div class="mark" aria-label="聚合标记"></div><div class="meta"><b>Emergence</b><br>独立模式<br>1 会话 · <span id="status">就绪</span></div></div><nav>${['等待', '思考中', '调用工具', '完成', '错误'].map((label, i) => `<button data-state="${states[i]}" aria-pressed="${i === 0}">${label}</button>`).join('')}</nav><p>下方为真实 OpenTUI 组件的静态界面预览。</p><iframe src="workspace-preview.html" title="实际工作台布局"></iframe></main><script>
const frames=${JSON.stringify(frames)}, mark=document.querySelector('.mark');for(let i=0;i<96;i++)mark.append(document.createElement('i'));let state='idle',tick=0;function paint(){frames[state][matchMedia('(prefers-reduced-motion: reduce)').matches?0:tick%20].flat().forEach((color,i)=>mark.children[i].style.background=color);}document.querySelectorAll('button').forEach(button=>button.onclick=()=>{state=button.dataset.state;tick=0;document.querySelector('#status').textContent=button.textContent;document.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));paint();});paint();setInterval(()=>{tick++;paint()},450);
</script></html>`,
);
