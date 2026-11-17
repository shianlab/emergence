// Native Windows Forms controls only. No HTML, WebView, browser process or UI dependencies.
// Uses the same authenticated configuration service as the TUI, preserving its validation and DPAPI logic.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;

namespace Emergence.ModelConfiguration
{
    sealed partial class ConfigurationForm
    {
        void RenderModels()
        {
            Clear(library);
            fields.Clear();
            if (editing)
            {
                RenderEditor();
                return;
            }
            int y = 10;
            Put(library, Label("已添加 " + Json.Rows(state, "models").Count() + " 个模型", false), 10, y, 310, 28);
            Put(library, Button("＋ 添加模型", delegate
            {
                if (CanLeave())
                    Edit(null);
            }), 360, y, 116, 28);
            y += 40;
            foreach (var model in Json.Rows(state, "models"))
            {
                var id = Json.Str(model, "id");
                var credential = Json.Str(model, "credentialSource") == "environment" ? "环境变量优先" : Json.Yes(model, "credentialConfigured") ? "已配置 Key" : "待配置 Key";
                var text = Json.Str(model, "provider") + " / " + Json.Str(model, "model") + "\n" + id + (id == Json.Str(state, "defaultModel") ? " · 默认" : "") + " · " + credential;
                var item = Button(text, delegate
                {
                    if (CanLeave())
                        Edit(id);
                });
                item.TextAlign = ContentAlignment.MiddleLeft;
                Put(library, item, 10, y, 466, 58);
                y += 66;
            }
            Put(library, Label("点击模型编辑；前往“分配”选择各窗口模型。", false), 10, y + 2, 466, 30);
            modelHeight = y + 38;
        }
        void Edit(string id)
        {
            editor.Begin(state, id);
            details = false;
            advanced = false;
            RenderModels();
            Fit();
            Control focus;
            if (fields.TryGetValue(id == null ? "preset" : "secret", out focus))
                focus.Focus();
        }
        void MarkDirty()
        {
            if (!building)
            {
                dirty = true;
                Notice("有未保存的修改");
            }
        }
        TextBox Input(string name, string value, int x, int y, int width, bool password)
        {
            var input = new TextBox { Text = value, UseSystemPasswordChar = password, AccessibleName = name == "secret" ? "API 密钥" : name };
            input.TextChanged += delegate
            {
                MarkDirty();
            };
            fields[name] = input;
            Put(library, input, x, y, width, 28);
            return input;
        }
        void Caption(string text, int x, int y, int width)
        {
            Put(library, Label(text, false), x, y, width, 23);
        }
        void RenderEditor()
        {
            building = true;
            try
            {
                int y = 10;
                Put(library, Button("‹ 返回模型库", delegate
                {
                    if (CanLeave())
                    {
                        editing = false;
                        RenderModels();
                        Fit();
                        Notice("");
                    }
                }), 10, y, 114, 27);
                Put(library, Label(selected == null ? "添加模型" : "编辑模型 · " + selected, true), 136, y, 340, 27);
                y += 40;
                Caption("厂商 / 接入方式", 10, y, 466);
                y += 24;
                var picker = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, AccessibleName = "厂商接入方式" };
                picker.Items.Add(new Choice("", "自定义 / 手动填写"));
                foreach (var preset in Json.Rows(state, "presets"))
                    picker.Items.Add(new Choice(Json.Str(preset, "id"), Json.Str(preset, "label")));
                var matching = Json.Rows(state, "presets").FirstOrDefault(p => Json.Str(p, "baseURL") == Json.Str(draft, "baseURL") && Json.Str(p, "provider") == Json.Str(draft, "provider"));
                picker.SelectedIndex = 0;
                if (matching != null)
                    for (int n = 1; n < picker.Items.Count; n++)
                        if (((Choice)picker.Items[n]).Id == Json.Str(matching, "id"))
                            picker.SelectedIndex = n;
                fields["preset"] = picker;
                Put(library, picker, 10, y, 466, 30);
                y += 34;
                Put(library, Label(matching == null ? "自定义连接，请展开连接信息填写地址和协议。" : Json.Str(matching, "note"), false), 10, y, 466, 34);
                y += 40;
                picker.SelectionChangeCommitted += delegate
                {
                    CaptureDraft();
                    var choice = picker.SelectedItem as Choice;
                    var preset = Json.Rows(state, "presets").FirstOrDefault(p => Json.Str(p, "id") == choice.Id);
                    if (preset != null)
                    {
                        foreach (var name in new[] { "provider", "model", "api", "baseURL", "apiKeyEnv" })
                            draft[name] = Json.Get(preset, name);
                        if (selected == null)
                        {
                            string candidate = Json.Str(preset, "id");
                            int suffix = 2;
                            while (Json.Rows(state, "models").Any(m => Json.Str(m, "id") == candidate))
                                candidate = Json.Str(preset, "id") + "-" + (suffix++);
                            draft["id"] = candidate;
                        }
                        secret = "";
                        details = String.IsNullOrEmpty(Json.Str(draft, "baseURL"));
                        dirty = true;
                    }
                    else
                    {
                        details = true;
                    }
                    RenderModels();
                    Fit();
                    fields["secret"].Focus();
                    Notice("已填写接入信息；切换厂商后请粘贴对应 Key。");
                };
                Caption("模型名称", 10, y, 220);
                Caption("API 密钥 · 留空保留", 250, y, 226);
                y += 24;
                var modelInput = new ComboBox { Text = Json.Str(draft, "model"), AccessibleName = "模型名称" };
                if (matching != null)
                {
                    var models = Json.Get(matching, "models") as IEnumerable;
                    if (models != null)
                        foreach (var m in models)
                            modelInput.Items.Add(Convert.ToString(m));
                }
                modelInput.TextChanged += delegate
                {
                    MarkDirty();
                };
                fields["model"] = modelInput;
                Put(library, modelInput, 10, y, 226, 28);
                Input("secret", secret, 250, y, 226, true);
                y += 42;
                Put(library, Button((details ? "▾" : "▸") + " 连接信息", delegate
                {
                    CaptureDraft();
                    details = !details;
                    RenderModels();
                    Fit();
                }), 10, y, 466, 28);
                y += 36;
                if (details)
                {
                    Caption("供应商名称", 10, y, 220);
                    Caption("配置 ID", 250, y, 226);
                    y += 24;
                    Input("provider", Json.Str(draft, "provider"), 10, y, 226, false);
                    Input("id", Json.Str(draft, "id"), 250, y, 226, false).ReadOnly = selected != null;
                    y += 37;
                    Caption("接口协议", 10, y, 220);
                    Caption("密钥环境变量", 250, y, 226);
                    y += 24;
                    var protocol = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, AccessibleName = "接口协议" };
                    protocol.Items.AddRange(new object[] { new Choice("openai-completions", "OpenAI · Chat Completions"), new Choice("openai-responses", "OpenAI · Responses"), new Choice("anthropic-messages", "Anthropic · Messages"), new Choice("google-generative-ai", "Google · OpenAI 兼容") });
                    protocol.SelectedIndex = 0;
                    foreach (Choice c in protocol.Items)
                        if (c.Id == Json.Str(draft, "api"))
                            protocol.SelectedItem = c;
                    protocol.SelectedIndexChanged += delegate
                    {
                        MarkDirty();
                    };
                    fields["api"] = protocol;
                    Put(library, protocol, 10, y, 226, 28);
                    Input("apiKeyEnv", Json.Str(draft, "apiKeyEnv"), 250, y, 226, false);
                    y += 37;
                    Caption("接口基础地址（不含 /chat/completions 等请求路径）", 10, y, 466);
                    y += 24;
                    Input("baseURL", Json.Str(draft, "baseURL"), 10, y, 466, false);
                    y += 40;
                }
                Put(library, Button((advanced ? "▾" : "▸") + " 高级参数", delegate
                {
                    CaptureDraft();
                    advanced = !advanced;
                    RenderModels();
                    Fit();
                }), 10, y, 466, 28);
                y += 36;
                if (advanced)
                {
                    Caption("上下文长度", 10, y, 220);
                    Caption("最大输出 Token", 250, y, 226);
                    y += 24;
                    foreach (var name in new[] { "contextWindow", "maxTokens" })
                    {
                        // Match the backend's positive JavaScript safe-integer schema without truncation.
                        var number = new NumericUpDown { Minimum = 1, Maximum = 9007199254740991m, Value = Convert.ToDecimal(Json.Get(draft, name)), AccessibleName = name };
                        number.ValueChanged += delegate
                        {
                            MarkDirty();
                        };
                        fields[name] = number;
                        Put(library, number, name == "contextWindow" ? 10 : 250, y, 226, 28);
                    }
                    y += 36;
                    foreach (var name in new[] { "tools", "vision" })
                    {
                        var value = Json.Get(Json.Get(draft, "capabilities"), name);
                        var box = new CheckBox { Text = name == "tools" ? "工具调用（灰色为自动）" : "图像输入（灰色为自动）", ThreeState = true, CheckState = value == null ? CheckState.Indeterminate : (bool)value ? CheckState.Checked : CheckState.Unchecked };
                        box.CheckStateChanged += delegate
                        {
                            MarkDirty();
                        };
                        fields[name] = box;
                        Put(library, box, name == "tools" ? 10 : 250, y, 226, 28);
                    }
                    y += 36;
                }
                if (selected != null)
                    Put(library, Button("删除", async delegate
                    {
                        if (MessageBox.Show(this, "删除此模型配置？请先解除窗口与默认规则引用。", "删除模型", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
                            return;
                        await Run(RemoveModel);
                    }), 10, y, 72, 30);
                Put(library, Button("测试连接", async delegate { await Run(TestConnection); }), 280, y, 96, 30);
                Put(library, Button("保存", async delegate { await Run(SaveModel); }), 386, y, 90, 30);
                y += 40;
                Put(library, Label("Key 仅本机加密保存，显式环境变量优先。连接测试会产生少量 API 用量。", false), 10, y, 466, 35);
                modelHeight = y + 43;
            }
            finally { building = false; }
        }
        void CaptureDraft()
        {
            foreach (var name in new[] { "provider", "id", "model", "baseURL", "apiKeyEnv" })
                if (fields.ContainsKey(name))
                    draft[name] = fields[name].Text.Trim();
            if (fields.ContainsKey("secret"))
                secret = fields["secret"].Text.Trim();
            if (fields.ContainsKey("api"))
                draft["api"] = ((Choice)((ComboBox)fields["api"]).SelectedItem).Id;
            foreach (var name in new[] { "contextWindow", "maxTokens" })
                if (fields.ContainsKey(name))
                    draft[name] = Convert.ToInt64(((NumericUpDown)fields[name]).Value);
            if (fields.ContainsKey("tools"))
            {
                var capabilities = new Dictionary<string, object>();
                foreach (var name in new[] { "tools", "vision" })
                {
                    var value = ((CheckBox)fields[name]).CheckState;
                    if (value != CheckState.Indeterminate)
                        capabilities[name] = value == CheckState.Checked;
                }
                if (capabilities.Count > 0)
                    draft["capabilities"] = capabilities;
                else
                    draft.Remove("capabilities");
            }
        }
        void ValidateDraft()
        {
            if (!editor.Valid)
            {
                details = true;
                RenderModels();
                Fit();
                throw new Exception("请选择厂商并填写模型名称；自定义接入请补齐连接信息（配置 ID 使用小写字母、数字、下划线或短横线）。");
            }
        }
        ComboBox Models(Control parent, string value, bool inherit, int x, int y, int width, string accessible)
        {
            var input = new ComboBox { DropDownStyle = ComboBoxStyle.DropDownList, AccessibleName = accessible };
            if (inherit)
                input.Items.Add(new Choice("", "使用默认规则"));
            foreach (var m in Json.Rows(state, "models"))
                input.Items.Add(new Choice(Json.Str(m, "id"), Json.Str(m, "provider") + " / " + Json.Str(m, "model") + " · " + Json.Str(m, "id")));
            input.SelectedIndex = 0;
            foreach (Choice choice in input.Items)
                if (choice.Id == value)
                    input.SelectedItem = choice;
            Put(parent, input, x, y, width, 28);
            return input;
        }
        void RenderWindows()
        {
            Clear(allocation);
            int y = 10;
            var windows = Json.Rows(state, "windows").ToList();
            Put(allocation, Label(windows.Count > 0 ? "当前窗口 " + windows.Count : "当前无活动窗口，可设置新窗口默认模型。", true), 10, y, 466, 28);
            y += 34;
            foreach (var window in windows)
            {
                string id = Json.Str(window, "id");
                Put(allocation, Label("窗口 " + Json.Str(window, "number") + " · " + Json.Str(window, "role") + " · " + Json.Str(window, "status"), true), 10, y, 466, 26);
                y += 27;
                var select = Models(allocation, Json.Str(window, "modelId"), false, 10, y, 366, "窗口 " + Json.Str(window, "number") + " 模型");
                var apply = Button("应用", async delegate
                {
                    var choice = select.SelectedItem as Choice;
                    if (choice == null)
                        return;
                    await Run(() => AssignWindow(id, choice.Id, Json.Str(window, "number")));
                });
                apply.Enabled = Json.Yes(window, "mutable");
                select.Enabled = apply.Enabled;
                Put(allocation, apply, 386, y, 90, 28);
                y += 31;
                Put(allocation, Label(Json.Str(window, "cwd"), false), 10, y, 466, 24);
                y += 34;
            }
            bool expanded = defaultsOpen || !Json.Yes(state, "live") || windows.Count == 0;
            Put(allocation, Button((expanded ? "▾" : "▸") + " 默认分配 · 新建窗口时使用", delegate
            {
                defaultsOpen = !expanded;
                if (windows.Count == 0)
                    defaultsOpen = true;
                RenderWindows();
                Fit();
            }), 10, y, 466, 28);
            y += 36;
            if (expanded)
            {
                var labels = new[] { "全局默认", "新窗口默认" };
                var names = new[] { "defaultModel", "single" };
                for (int n = 0; n < labels.Length; n++)
                {
                    string name = names[n];
                    int x = n % 2 == 0 ? 10 : 250;
                    Put(allocation, Label(labels[n], false), x, y, 226, 24);
                    var selection = Models(allocation, name == "defaultModel" ? defaultId : Json.Str(rules, name), name != "defaultModel", x, y + 24, 226, labels[n]);
                    selection.SelectedIndexChanged += delegate
                    {
                        var value = ((Choice)selection.SelectedItem).Id;
                        if (name == "defaultModel")
                            defaultId = value;
                        else if (value.Length == 0)
                            rules.Remove(name);
                        else
                            rules[name] = value;
                        defaultsDirty = true;
                        Notice("默认分配有未保存的修改");
                    };
                    if (n % 2 == 1)
                        y += 62;
                }
                Put(allocation, Button((slotsOpen ? "▾" : "▸") + " 按窗口编号设置 · 02–16", delegate
                {
                    slotsOpen = !slotsOpen;
                    RenderWindows();
                    Fit();
                }), 10, y, 466, 28);
                y += 36;
                if (slotsOpen)
                {
                    for (int n = 2; n <= 16; n++)
                    {
                        string slot = n.ToString();
                        int x = n % 2 == 0 ? 10 : 250;
                        Put(allocation, Label("窗口 " + n.ToString("00"), false), x, y, 226, 24);
                        var selection = Models(allocation, Json.Str(Json.Get(rules, "slots"), slot), true, x, y + 24, 226, "窗口 " + slot + " 默认模型");
                        selection.SelectedIndexChanged += delegate
                        {
                            var value = ((Choice)selection.SelectedItem).Id;
                            var slots = Json.Map(Json.Get(rules, "slots"));
                            if (value.Length == 0)
                                slots.Remove(slot);
                            else
                                slots[slot] = value;
                            defaultsDirty = true;
                            Notice("默认分配有未保存的修改");
                        };
                        if (n % 2 == 1 || n == 16)
                            y += 62;
                    }
                }
                Put(allocation, Label("保存默认不会更换已有窗口的模型。", false), 10, y, 310, 30);
                Put(allocation, Button("保存默认", async delegate { await Run(SaveDefaults); }), 366, y, 110, 30);
                y += 40;
            }
            windowHeight = y + 8;
        }
    }
}
