// Native Windows Forms controls only. No HTML, WebView, browser process or UI dependencies.
// Uses the same authenticated configuration service as the TUI, preserving its validation and DPAPI logic.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace Emergence.ModelConfiguration {
static class Json {
    internal static JavaScriptSerializer Codec = new JavaScriptSerializer { MaxJsonLength = 2097152 };
    internal static Dictionary<string, object> Map(object value) { return value as Dictionary<string, object> ?? new Dictionary<string, object>(); }
    internal static object Get(object value, string key) { object result; return Map(value).TryGetValue(key, out result) ? result : null; }
    internal static string Str(object value, string key) { return Convert.ToString(Get(value, key)) ?? ""; }
    internal static bool Yes(object value, string key) { return Get(value, key) is bool && (bool)Get(value, key); }
    internal static IEnumerable<Dictionary<string, object>> Rows(object value, string key) {
        var rows = Get(value, key) as IEnumerable;
        return rows == null ? Enumerable.Empty<Dictionary<string, object>>() : rows.Cast<object>().Select(Map);
    }
    internal static Dictionary<string, object> Copy(object value) { return Map(Codec.DeserializeObject(Codec.Serialize(value))); }
}

sealed class Connection : IDisposable {
    internal HttpClient Client;
    internal Process Backend;
    internal bool Attached;
    internal async Task<Dictionary<string, object>> Start(string[] args) {
        Attached = args.Contains("--attach");
        string url;
        if (Attached) {
            var line = await Console.In.ReadLineAsync();
            url = Json.Str(Json.Codec.DeserializeObject(line ?? "{}"), "url");
        } else {
            var location = AppDomain.CurrentDomain.BaseDirectory;
            var app = new[] { location, Path.Combine(location, "emergence"), Path.Combine(location, "app"), Path.Combine(location, "..", "..") }
                .Select(Path.GetFullPath).FirstOrDefault(p => File.Exists(Path.Combine(p, "dist", "cli.mjs")));
            if (app == null) throw new Exception("未找到涌现运行文件，请把此工具保留在涌现项目或发行目录中。");
            var node = new[] { Path.Combine(app, "node_modules", "node", "bin", "node.exe"), Path.Combine(app, "..", "runtime", "node.exe") }.FirstOrDefault(File.Exists);
            if (node == null) throw new Exception("未找到涌现自带的 Node 运行时，请使用完整的涌现安装目录。");
            var arguments = "--experimental-ffi --disable-warning=ExperimentalWarning " + Quote(Path.Combine(app, "dist", "cli.mjs")) + " model-config --native-service";
            for (int i = 0; i < args.Length; i++) {
                if (args[i] == "--home" && i + 1 < args.Length) { arguments += " --home " + Quote(Path.GetFullPath(args[++i])); }
                else throw new Exception("不支持的启动参数。支持 --home 配置目录。");
            }
            Backend = Process.Start(new ProcessStartInfo(node, arguments) { WorkingDirectory = app, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 });
            // Drain stderr without persisting credentials or provider diagnostics.
            Backend.ErrorDataReceived += delegate { }; Backend.BeginErrorReadLine();
            var read = Backend.StandardOutput.ReadLineAsync();
            if (await Task.WhenAny(read, Task.Delay(15000)) != read) throw new Exception("启动配置服务超时，请检查涌现安装。");
            var line = await read;
            if (line == null) throw new Exception("配置服务未能启动，请检查配置文件或使用 emergence doctor 诊断。");
            url = Json.Str(Json.Codec.DeserializeObject(line), "url");
        }
        Uri address;
        if (!Uri.TryCreate(url, UriKind.Absolute, out address) || address.Scheme != "http" || address.Host != "127.0.0.1" || address.AbsolutePath != "/") throw new Exception("配置服务地址无效。");
        var token = address.Fragment.StartsWith("#session=") ? address.Fragment.Substring(9) : "";
        if (!Regex.IsMatch(token, "^[a-f0-9]{64}$")) throw new Exception("配置服务会话无效。");
        Client = new HttpClient(new HttpClientHandler { UseProxy = false }) { BaseAddress = new Uri(address.GetLeftPart(UriPartial.Authority)), Timeout = TimeSpan.FromSeconds(30) };
        Client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return await Call("/api/state", null);
    }
    internal static string Quote(string value) { return "\"" + Regex.Replace(Regex.Replace(value, "(\\\\*)\"", "$1$1\\\""), "(\\\\+)$", "$1$1") + "\""; }
    internal async Task<Dictionary<string, object>> Call(string path, object body) {
        using (var response = body == null ? await Client.GetAsync(path) : await Client.PostAsync(path, new StringContent(Json.Codec.Serialize(body), Encoding.UTF8, "application/json"))) {
            var payload = await response.Content.ReadAsStringAsync();
            if (payload.Length > 2097152) throw new Exception("配置服务返回内容过大。");
            var result = Json.Map(Json.Codec.DeserializeObject(payload));
            if (!response.IsSuccessStatusCode) throw new Exception(Json.Str(result, "error"));
            return result;
        }
    }
    public void Dispose() {
        if (Client != null) Client.Dispose();
        if (Backend != null) {
            try { if (!Backend.HasExited) { Backend.StandardInput.WriteLine("close"); Backend.StandardInput.Close(); if (!Backend.WaitForExit(3000)) Backend.Kill(); } } catch { }
            Backend.Dispose();
        }
    }
}

sealed class Choice {
    internal string Id, Label;
    internal Choice(string id, string label) { Id = id; Label = label; }
    public override string ToString() { return Label; }
}

sealed class ConfigurationForm : Form {
    readonly Connection connection;
    Dictionary<string, object> state, draft, rules;
    readonly TabControl tabs = new TabControl();
    readonly TabPage library = new TabPage("模型库"), allocation = new TabPage("分配");
    readonly Label status = new Label();
    readonly Label mode = new Label();
    readonly Timer poll = new Timer { Interval = 4000 };
    readonly Dictionary<string, Control> fields = new Dictionary<string, Control>();
    string selected, secret = "", defaultId;
    bool editing, dirty, defaultsDirty, busy, disconnected, building, details, advanced, defaultsOpen, slotsOpen, shuttingDown;
    int modelHeight = 230, windowHeight = 230;
    float scale;
    PictureBox brand;
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);

    internal ConfigurationForm(Connection backend, Dictionary<string, object> initial) {
        connection = backend; state = initial;
        using (var graphics = CreateGraphics()) scale = graphics.DpiX / 96f;
        Text = "涌现 · 模型配置"; Name = "EmergenceNativeModelConfiguration";
        Font = new Font("Microsoft YaHei UI", 9f); BackColor = Color.White; ForeColor = Color.FromArgb(40,40,40);
        AutoScaleMode = AutoScaleMode.None; FormBorderStyle = FormBorderStyle.FixedSingle; MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen; Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        var image = Image.FromStream(Assembly.GetExecutingAssembly().GetManifestResourceStream("Wordmark"));
        // The approved light wordmark is recolored to dark gray without changing its silhouette.
        var dark = new Bitmap(image.Width, image.Height);
        using (var g = Graphics.FromImage(dark)) using (var attributes = new ImageAttributes()) {
            attributes.SetColorMatrix(new ColorMatrix(new float[][] { new float[]{0,0,0,0,0}, new float[]{0,0,0,0,0}, new float[]{0,0,0,0,0}, new float[]{0,0,0,1,0}, new float[]{.16f,.16f,.16f,0,1} }));
            g.DrawImage(image, new Rectangle(0,0,image.Width,image.Height),0,0,image.Width,image.Height,GraphicsUnit.Pixel,attributes);
        }
        image.Dispose(); brand = new PictureBox { Image = dark, SizeMode = PictureBoxSizeMode.Zoom };
        Put(this, brand, 16, 12, 65, 30);
        var title = Label("模型配置", true); Put(this, title, 94, 15, 130, 24);
        mode.TextAlign = ContentAlignment.MiddleRight; mode.ForeColor = Color.DimGray; Put(this, mode, 302, 15, 148, 24);
        var refresh = Button("刷新", async delegate { if (CanLeave()) await Run(async delegate { state = await connection.Call("/api/state", null); editing = false; ResetRules(); Render(); Notice("状态已刷新"); }); });
        Put(this, refresh, 456, 12, 48, 28);
        tabs.TabPages.AddRange(new[] { library, allocation }); tabs.SelectedIndex=0; tabs.Padding = new Point(S(26), S(6));
        Put(this, tabs, 12, 56, 496, 250);
        foreach (var page in new[] { library, allocation }) { page.BackColor = Color.White; page.AutoScroll = true; page.Padding = new Padding(0); }
        status.AutoEllipsis = true; status.ForeColor = Color.DimGray; status.AccessibleName = "操作结果";
        Controls.Add(status);
        tabs.Selecting += delegate(object sender, TabControlCancelEventArgs e) { if (building) return; if (busy || !CanLeave()) e.Cancel = true; else { if (editing) { editing = false; RenderModels(); } ResetRules(); RenderWindows(); } };
        tabs.SelectedIndexChanged += delegate { Fit(); };
        FormClosing += delegate(object sender, FormClosingEventArgs e) { if (!shuttingDown && (busy || !CanLeave())) { e.Cancel = true; if (busy) Notice("请等待当前操作完成后关闭。"); } };
        FormClosed += delegate { poll.Stop(); connection.Dispose(); brand.Image.Dispose(); };
        Shown += delegate { Fit(); Console.Out.WriteLine(Json.Codec.Serialize(new {ready=true,backendPid=connection.Backend==null?0:connection.Backend.Id})); Console.Out.Flush(); if (connection.Attached) ReadCommands(); };
        poll.Tick += async delegate {
            if (busy || disconnected || editing || defaultsDirty) return;
            try {
                var latest = await connection.Call("/api/state", null);
                if (busy || editing || defaultsDirty || IsDisposed) return;
                if (Json.Str(latest, "revision") != Json.Str(state, "revision")) { Notice("配置已被其他窗口修改，请点击刷新加载最新配置。"); return; }
                state = latest;
                // A native dropdown or focused selection must not be destroyed by polling.
                if (tabs.SelectedIndex == 1 && !allocation.ContainsFocus) { RenderWindows(); Fit(); }
            } catch { disconnected = true; tabs.Enabled = false; mode.Text = "服务已断开"; Notice("配置服务已关闭，请从涌现重新打开。当前草稿仍保留。"); }
        };
        ResetRules(); Render(); poll.Start();
    }
    int S(int value) { return (int)Math.Round(value * scale); }
    void Put(Control parent, Control child, int x, int y, int width, int height) { child.SetBounds(S(x),S(y),S(width),S(height)); parent.Controls.Add(child); }
    Label Label(string text, bool bold) { return new Label { Text = text, AutoEllipsis = true, TextAlign = ContentAlignment.MiddleLeft, Font = new Font(Font, bold ? FontStyle.Bold : FontStyle.Regular), BackColor = Color.Transparent }; }
    Button Button(string text, EventHandler action) { var b = new Button { Text = text, UseVisualStyleBackColor = true, AutoEllipsis = true }; b.Click += action; return b; }
    void Clear(Control parent) { while (parent.Controls.Count > 0) parent.Controls[0].Dispose(); }
    void Notice(string text) { status.Text = text; status.AccessibleName="操作结果："+text; }
    bool CanLeave() {
        if (!dirty && !defaultsDirty) return true;
        if (MessageBox.Show(this, "有未保存的修改，是否放弃？", "涌现 · 模型配置", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return false;
        dirty = false; defaultsDirty = false; secret = ""; return true;
    }
    async Task Run(Func<Task> action) {
        if (busy || disconnected) return; busy = true; tabs.Enabled = false;
        try { await action(); } catch (Exception error) { Notice(error is HttpRequestException || error is TaskCanceledException ? "无法连接配置服务，请检查服务状态后重试。" : error.Message); }
        finally { busy = false; if (!IsDisposed) tabs.Enabled = !disconnected; }
    }
    void ResetRules() { rules = Json.Copy(Json.Get(state, "windowModels")); if (Json.Get(rules,"slots") == null) rules["slots"] = new Dictionary<string,object>(); defaultId = Json.Str(state,"defaultModel"); defaultsDirty = false; }
    void Render() { building = true; try { mode.Text = Json.Yes(state,"live") ? "工作台已连接" : "独立配置"; RenderModels(); RenderWindows(); Fit(); } finally { building = false; } }
    void Fit() {
        int content = tabs.SelectedIndex == 0 ? modelHeight : windowHeight;
        int target = Math.Min(S(content + 142), Screen.FromControl(this).WorkingArea.Height - S(60));
        ClientSize = new Size(S(520), Math.Max(S(290), target));
        tabs.Height = ClientSize.Height - S(104); status.SetBounds(S(16),ClientSize.Height-S(42),S(488),S(34));
        if (Bottom > Screen.FromControl(this).WorkingArea.Bottom) Top = Math.Max(Screen.FromControl(this).WorkingArea.Top, Screen.FromControl(this).WorkingArea.Bottom - Height);
    }
    void RenderModels() {
        Clear(library); fields.Clear();
        if (editing) { RenderEditor(); return; }
        int y = 10;
        Put(library, Label("已添加 " + Json.Rows(state,"models").Count() + " 个模型", false), 10,y,310,28);
        Put(library,Button("＋ 添加模型",delegate { if (CanLeave()) Edit(null); }),360,y,116,28); y += 40;
        foreach (var model in Json.Rows(state,"models")) {
            var id = Json.Str(model,"id");
            var credential = Json.Str(model,"credentialSource") == "environment" ? "环境变量优先" : Json.Yes(model,"credentialConfigured") ? "已配置 Key" : "待配置 Key";
            var text = Json.Str(model,"provider") + " / " + Json.Str(model,"model") + "\n" + id + (id == Json.Str(state,"defaultModel") ? " · 默认" : "") + " · " + credential;
            var item = Button(text,delegate { if (CanLeave()) Edit(id); }); item.TextAlign = ContentAlignment.MiddleLeft;
            Put(library,item,10,y,466,58); y += 66;
        }
        Put(library,Label("点击模型编辑；前往“分配”选择各窗口模型。",false),10,y+2,466,30);
        modelHeight = y+38;
    }
    void Edit(string id) {
        selected = id; editing = true; details = false; advanced = false; dirty = false; secret = "";
        var previous = Json.Rows(state,"models").FirstOrDefault(m => Json.Str(m,"id") == id);
        draft = previous == null ? new Dictionary<string,object> { {"id",""},{"provider",""},{"model",""},{"api","openai-completions"},{"baseURL",""},{"apiKeyEnv",""},{"contextWindow",128000},{"maxTokens",8192} } : Json.Copy(previous);
        draft.Remove("credentialConfigured"); draft.Remove("credentialSource");
        RenderModels(); Fit();
        Control focus; if (fields.TryGetValue(id == null ? "preset" : "secret", out focus)) focus.Focus();
    }
    void MarkDirty() { if (!building) { dirty = true; Notice("有未保存的修改"); } }
    TextBox Input(string name, string value, int x, int y, int width, bool password) {
        var input = new TextBox { Text = value, UseSystemPasswordChar = password, AccessibleName = name == "secret" ? "API 密钥" : name };
        input.TextChanged += delegate { MarkDirty(); }; fields[name] = input; Put(library,input,x,y,width,28); return input;
    }
    void Caption(string text, int x, int y, int width) { Put(library,Label(text,false),x,y,width,23); }
    void RenderEditor() {
        building = true;
        try {
            int y = 10;
            Put(library,Button("‹ 返回模型库",delegate { if (CanLeave()) { editing = false; RenderModels(); Fit(); Notice(""); } }),10,y,114,27);
            Put(library,Label(selected == null ? "添加模型" : "编辑模型 · " + selected,true),136,y,340,27); y += 40;
            Caption("厂商 / 接入方式",10,y,466); y += 24;
            var picker = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, AccessibleName = "厂商接入方式" };
            picker.Items.Add(new Choice("", "自定义 / 手动填写"));
            foreach (var preset in Json.Rows(state,"presets")) picker.Items.Add(new Choice(Json.Str(preset,"id"),Json.Str(preset,"label")));
            var matching = Json.Rows(state,"presets").FirstOrDefault(p => Json.Str(p,"baseURL") == Json.Str(draft,"baseURL") && Json.Str(p,"provider") == Json.Str(draft,"provider"));
            picker.SelectedIndex = 0;
            if (matching != null) for (int n=1;n<picker.Items.Count;n++) if (((Choice)picker.Items[n]).Id == Json.Str(matching,"id")) picker.SelectedIndex=n;
            fields["preset"] = picker; Put(library,picker,10,y,466,30); y += 34;
            Put(library,Label(matching == null ? "自定义连接，请展开连接信息填写地址和协议。" : Json.Str(matching,"note"),false),10,y,466,34); y += 40;
            picker.SelectionChangeCommitted += delegate {
                CaptureDraft(); var choice = picker.SelectedItem as Choice;
                var preset = Json.Rows(state,"presets").FirstOrDefault(p => Json.Str(p,"id") == choice.Id);
                if (preset != null) {
                    foreach (var name in new[]{"provider","model","api","baseURL","apiKeyEnv"}) draft[name] = Json.Get(preset,name);
                    if (selected == null) {
                        string candidate = Json.Str(preset,"id"); int suffix=2;
                        while (Json.Rows(state,"models").Any(m=>Json.Str(m,"id")==candidate)) candidate=Json.Str(preset,"id")+"-"+(suffix++);
                        draft["id"] = candidate;
                    }
                    secret=""; details=String.IsNullOrEmpty(Json.Str(draft,"baseURL")); dirty=true;
                } else { details=true; }
                RenderModels(); Fit(); fields["secret"].Focus(); Notice("已填写接入信息；切换厂商后请粘贴对应 Key。");
            };
            Caption("模型名称",10,y,220); Caption("API 密钥 · 留空保留",250,y,226); y+=24;
            var modelInput = new ComboBox { Text = Json.Str(draft,"model"), AccessibleName="模型名称" };
            if (matching != null) { var models = Json.Get(matching,"models") as IEnumerable; if (models != null) foreach(var m in models) modelInput.Items.Add(Convert.ToString(m)); }
            modelInput.TextChanged += delegate { MarkDirty(); }; fields["model"]=modelInput; Put(library,modelInput,10,y,226,28);
            Input("secret",secret,250,y,226,true); y+=42;
            Put(library,Button((details ? "▾" : "▸")+" 连接信息",delegate { CaptureDraft(); details=!details; RenderModels(); Fit(); }),10,y,466,28); y+=36;
            if (details) {
                Caption("供应商名称",10,y,220); Caption("配置 ID",250,y,226); y+=24;
                Input("provider",Json.Str(draft,"provider"),10,y,226,false); Input("id",Json.Str(draft,"id"),250,y,226,false).ReadOnly=selected!=null; y+=37;
                Caption("接口协议",10,y,220); Caption("密钥环境变量",250,y,226); y+=24;
                var protocol = new ComboBox { DropDownStyle=ComboBoxStyle.DropDownList,AccessibleName="接口协议" };
                protocol.Items.AddRange(new object[]{new Choice("openai-completions","OpenAI · Chat Completions"),new Choice("openai-responses","OpenAI · Responses"),new Choice("anthropic-messages","Anthropic · Messages"),new Choice("google-generative-ai","Google · OpenAI 兼容")});
                protocol.SelectedIndex=0; foreach(Choice c in protocol.Items) if(c.Id==Json.Str(draft,"api")) protocol.SelectedItem=c;
                protocol.SelectedIndexChanged+=delegate{MarkDirty();}; fields["api"]=protocol; Put(library,protocol,10,y,226,28);
                Input("apiKeyEnv",Json.Str(draft,"apiKeyEnv"),250,y,226,false); y+=37;
                Caption("接口基础地址（不含 /chat/completions 等请求路径）",10,y,466); y+=24;
                Input("baseURL",Json.Str(draft,"baseURL"),10,y,466,false); y+=40;
            }
            Put(library,Button((advanced ? "▾" : "▸")+" 高级参数",delegate { CaptureDraft(); advanced=!advanced; RenderModels(); Fit(); }),10,y,466,28); y+=36;
            if (advanced) {
                Caption("上下文长度",10,y,220); Caption("最大输出 Token",250,y,226); y+=24;
                foreach(var name in new[]{"contextWindow","maxTokens"}) {
                    // Match the backend's positive JavaScript safe-integer schema without truncation.
                    var number=new NumericUpDown{Minimum=1,Maximum=9007199254740991m,Value=Convert.ToDecimal(Json.Get(draft,name)),AccessibleName=name};
                    number.ValueChanged+=delegate{MarkDirty();}; fields[name]=number; Put(library,number,name=="contextWindow"?10:250,y,226,28);
                } y+=36;
                foreach(var name in new[]{"tools","vision"}) {
                    var value=Json.Get(Json.Get(draft,"capabilities"),name);
                    var box=new CheckBox{Text=name=="tools"?"工具调用（灰色为自动）":"图像输入（灰色为自动）",ThreeState=true,CheckState=value==null?CheckState.Indeterminate:(bool)value?CheckState.Checked:CheckState.Unchecked};
                    box.CheckStateChanged+=delegate{MarkDirty();};fields[name]=box;Put(library,box,name=="tools"?10:250,y,226,28);
                } y+=36;
            }
            if(selected!=null) Put(library,Button("删除",async delegate {
                if(MessageBox.Show(this,"删除此模型配置？请先解除窗口与默认规则引用。","删除模型",MessageBoxButtons.YesNo,MessageBoxIcon.Question)!=DialogResult.Yes)return;
                await Run(async delegate { state=await connection.Call("/api/models/remove",new{revision=Json.Str(state,"revision"),id=selected});dirty=false;secret="";editing=false;ResetRules();Render();Notice("模型已删除。"); });
            }),10,y,72,30);
            Put(library,Button("测试连接",async delegate { await Run(async delegate { CaptureDraft(); ValidateDraft(); Notice("正在连接，最多等待 20 秒…");var result=await connection.Call("/api/test",new{model=draft,secret=secret}); Notice((Json.Yes(result,"ok")?"✓ ":"× ")+Json.Str(result,"message")+" · "+Json.Str(result,"elapsedMs")+" ms"); }); }),280,y,96,30);
            Put(library,Button("保存",async delegate { await Run(async delegate {
                CaptureDraft();ValidateDraft();state=await connection.Call("/api/models/save",new{revision=Json.Str(state,"revision"),model=draft,secret=secret});
                dirty=false;secret="";editing=false;ResetRules();Render();Notice(Json.Str(state,"credentialWarning").Length>0?Json.Str(state,"credentialWarning"):"模型已保存"+(Json.Yes(state,"live")?"，当前工作台已更新。":"，下次启动即可使用。"));
            }); }),386,y,90,30); y+=40;
            Put(library,Label("Key 仅本机加密保存，显式环境变量优先。连接测试会产生少量 API 用量。",false),10,y,466,35);
            modelHeight=y+43;
        } finally { building=false; }
    }
    void CaptureDraft() {
        foreach(var name in new[]{"provider","id","model","baseURL","apiKeyEnv"}) if(fields.ContainsKey(name)) draft[name]=fields[name].Text.Trim();
        if(fields.ContainsKey("secret"))secret=fields["secret"].Text.Trim();
        if(fields.ContainsKey("api")) draft["api"]=((Choice)((ComboBox)fields["api"]).SelectedItem).Id;
        foreach(var name in new[]{"contextWindow","maxTokens"}) if(fields.ContainsKey(name))draft[name]=Convert.ToInt64(((NumericUpDown)fields[name]).Value);
        if(fields.ContainsKey("tools")) {
            var capabilities=new Dictionary<string,object>();
            foreach(var name in new[]{"tools","vision"}) {var value=((CheckBox)fields[name]).CheckState;if(value!=CheckState.Indeterminate)capabilities[name]=value==CheckState.Checked;}
            if(capabilities.Count>0)draft["capabilities"]=capabilities;else draft.Remove("capabilities");
        }
    }
    void ValidateDraft() {
        if(!Regex.IsMatch(Json.Str(draft,"id"),"^[a-z0-9_-]{1,32}$") || new[]{"provider","model","baseURL","apiKeyEnv"}.Any(n=>String.IsNullOrWhiteSpace(Json.Str(draft,n)))) {
            details=true; RenderModels();Fit();throw new Exception("请选择厂商并填写模型名称；自定义接入请补齐连接信息（配置 ID 使用小写字母、数字、下划线或短横线）。");
        }
    }
    ComboBox Models(Control parent,string value,bool inherit,int x,int y,int width,string accessible) {
        var input=new ComboBox{DropDownStyle=ComboBoxStyle.DropDownList,AccessibleName=accessible};
        if(inherit)input.Items.Add(new Choice("","使用默认规则"));
        foreach(var m in Json.Rows(state,"models"))input.Items.Add(new Choice(Json.Str(m,"id"),Json.Str(m,"provider")+" / "+Json.Str(m,"model")+" · "+Json.Str(m,"id")));
        input.SelectedIndex=0;foreach(Choice choice in input.Items)if(choice.Id==value)input.SelectedItem=choice;
        Put(parent,input,x,y,width,28);return input;
    }
    void RenderWindows() {
        Clear(allocation);int y=10;
        var windows=Json.Rows(state,"windows").ToList();
        Put(allocation,Label(windows.Count>0?"当前窗口 "+windows.Count:"当前无活动窗口，可设置新窗口默认模型。",true),10,y,466,28);y+=34;
        foreach(var window in windows) {
            string id=Json.Str(window,"id");
            Put(allocation,Label("窗口 "+Json.Str(window,"number")+" · "+Json.Str(window,"role")+" · "+Json.Str(window,"status"),true),10,y,466,26);y+=27;
            var select=Models(allocation,Json.Str(window,"modelId"),false,10,y,366,"窗口 "+Json.Str(window,"number")+" 模型");
            var apply=Button("应用",async delegate { var choice=select.SelectedItem as Choice;await Run(async delegate {state=await connection.Call("/api/windows/assign",new{revision=Json.Str(state,"revision"),windowId=id,modelId=choice.Id});RenderWindows();Fit();Notice("已应用到窗口 "+Json.Str(window,"number")+"，下一轮使用所选模型；会话历史保留。");}); });
            apply.Enabled=Json.Yes(window,"mutable");select.Enabled=apply.Enabled;Put(allocation,apply,386,y,90,28);y+=31;
            Put(allocation,Label(Json.Str(window,"cwd"),false),10,y,466,24);y+=34;
        }
        bool expanded=defaultsOpen||!Json.Yes(state,"live")||windows.Count==0;
        Put(allocation,Button((expanded?"▾":"▸")+" 默认分配 · 新建窗口时使用",delegate { defaultsOpen=!expanded; if(windows.Count==0)defaultsOpen=true; RenderWindows();Fit(); }),10,y,466,28);y+=36;
        if(expanded) {
            var labels=new[]{"全局默认","新窗口默认"};var names=new[]{"defaultModel","single"};
            for(int n=0;n<labels.Length;n++) {
                string name=names[n];int x=n%2==0?10:250;
                Put(allocation,Label(labels[n],false),x,y,226,24);
                var selection=Models(allocation,name=="defaultModel"?defaultId:Json.Str(rules,name),name!="defaultModel",x,y+24,226,labels[n]);
                selection.SelectedIndexChanged+=delegate {var value=((Choice)selection.SelectedItem).Id;if(name=="defaultModel")defaultId=value;else if(value.Length==0)rules.Remove(name);else rules[name]=value;defaultsDirty=true;Notice("默认分配有未保存的修改");};
                if(n%2==1)y+=62;
            }
            Put(allocation,Button((slotsOpen?"▾":"▸")+" 按窗口编号设置 · 02–16",delegate {slotsOpen=!slotsOpen;RenderWindows();Fit();}),10,y,466,28);y+=36;
            if(slotsOpen) {
                for(int n=2;n<=16;n++) {
                    string slot=n.ToString();int x=n%2==0?10:250;
                    Put(allocation,Label("窗口 "+n.ToString("00"),false),x,y,226,24);
                    var selection=Models(allocation,Json.Str(Json.Get(rules,"slots"),slot),true,x,y+24,226,"窗口 "+slot+" 默认模型");
                    selection.SelectedIndexChanged+=delegate {var value=((Choice)selection.SelectedItem).Id;var slots=Json.Map(Json.Get(rules,"slots"));if(value.Length==0)slots.Remove(slot);else slots[slot]=value;defaultsDirty=true;Notice("默认分配有未保存的修改");};
                    if(n%2==1||n==16)y+=62;
                }
            }
            Put(allocation,Label("保存默认不会更换已有窗口的模型。",false),10,y,310,30);
            Put(allocation,Button("保存默认",async delegate {await Run(async delegate {state=await connection.Call("/api/defaults",new{revision=Json.Str(state,"revision"),defaultModel=defaultId,windowModels=rules});ResetRules();Render();Notice("默认规则已保存，将用于新建窗口。");});}),366,y,110,30);y+=40;
        }
        windowHeight=y+8;
    }
    void ReadCommands() {
        // Console.In is a synchronized TextReader on Framework: ReadLineAsync can block its caller.
        // Keep pipe reads off the UI thread so the native controls can paint and process input.
        Task.Run(delegate {
            try {
                string line;
                while((line=Console.In.ReadLine())!=null) {
                    var command=Json.Str(Json.Codec.DeserializeObject(line),"action");
                    if(IsDisposed)return;
                    BeginInvoke((Action)delegate {
                        if(command=="focus") {WindowState=FormWindowState.Normal;Show();SetForegroundWindow(Handle);Activate();}
                        if(command=="close") {shuttingDown=true;Close();}
                    });
                    if(command=="close")return;
                }
            }catch { }
            if(!IsDisposed) try {BeginInvoke((Action)delegate{shuttingDown=true;Close();});}catch { }
        });
    }
}

static class Program {
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("shell32.dll")] static extern int SetCurrentProcessExplicitAppUserModelID(string id);
    [STAThread] static void Main(string[] args) {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch(EntryPointNotFoundException) { }
        SetCurrentProcessExplicitAppUserModelID("Emergence.ModelConfiguration");
        Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
        // WinExe has no console; use redirected pipe streams without calling console code-page APIs.
        Console.SetIn(new StreamReader(Console.OpenStandardInput(),new UTF8Encoding(false)));
        Console.SetOut(new StreamWriter(Console.OpenStandardOutput(),new UTF8Encoding(false)){AutoFlush=true});
        Console.SetError(new StreamWriter(Console.OpenStandardError(),new UTF8Encoding(false)){AutoFlush=true});
        using(var connection=new Connection()) {
            try {
                // Bootstrap before creating controls; Start uses no UI synchronization context.
                var state=connection.Start(args).GetAwaiter().GetResult();
                Application.Run(new ConfigurationForm(connection,state));
            }catch(Exception error) {
                if(args.Contains("--attach"))Console.Error.WriteLine("无法启动原生模型配置窗口："+error.Message);
                else MessageBox.Show("无法打开模型配置："+error.Message,"涌现 · 模型配置",MessageBoxButtons.OK,MessageBoxIcon.Error);
                Environment.ExitCode=1;
            }
        }
    }
}
}
