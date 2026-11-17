// Native Windows Forms controls only. No HTML, WebView, browser process or UI dependencies.
// Uses the same authenticated configuration service as the TUI, preserving its validation and DPAPI logic.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Net.Http;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Emergence.ModelConfiguration
{
    sealed partial class ConfigurationForm : Form
    {
        readonly Connection connection;
        Dictionary<string, object> state, rules;
        readonly ModelDraft editor = new ModelDraft();
        Dictionary<string, object> draft
        {
            get
            {
                return editor.Value;
            }
        }
        string selected
        {
            get
            {
                return editor.Selected;
            }
        }
        string secret
        {
            get
            {
                return editor.Secret;
            }
            set
            {
                editor.Secret = value;
            }
        }
        bool editing
        {
            get
            {
                return editor.Editing;
            }
            set
            {
                editor.Editing = value;
            }
        }
        bool dirty
        {
            get
            {
                return editor.Dirty;
            }
            set
            {
                editor.Dirty = value;
            }
        }
        readonly TabControl tabs = new TabControl();
        readonly TabPage library = new TabPage("模型库"), allocation = new TabPage("分配");
        readonly Label status = new Label();
        readonly Label mode = new Label();
        readonly Timer poll = new Timer { Interval = 4000 };
        readonly Dictionary<string, Control> fields = new Dictionary<string, Control>();
        string defaultId;
        bool polling, defaultsDirty, busy, disconnected, building, details, advanced, defaultsOpen, slotsOpen, shuttingDown;
        int modelHeight = 230, windowHeight = 230;
        float scale;
        PictureBox brand;
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);

        internal ConfigurationForm(Connection backend, Dictionary<string, object> initial)
        {
            connection = backend;
            state = initial;
            using (var graphics = CreateGraphics())
                scale = graphics.DpiX / 96f;
            Text = "涌现 · 模型配置";
            Name = "EmergenceNativeModelConfiguration";
            Font = new Font("Microsoft YaHei UI", 9f);
            BackColor = Color.White;
            ForeColor = Color.FromArgb(40, 40, 40);
            AutoScaleMode = AutoScaleMode.None;
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            var image = Image.FromStream(Assembly.GetExecutingAssembly().GetManifestResourceStream("Wordmark"));
            // The approved light wordmark is recolored to dark gray without changing its silhouette.
            var dark = new Bitmap(image.Width, image.Height);
            using (var g = Graphics.FromImage(dark))
            using (var attributes = new ImageAttributes())
            {
                attributes.SetColorMatrix(new ColorMatrix(new float[][] { new float[] { 0, 0, 0, 0, 0 }, new float[] { 0, 0, 0, 0, 0 }, new float[] { 0, 0, 0, 0, 0 }, new float[] { 0, 0, 0, 1, 0 }, new float[] { .16f, .16f, .16f, 0, 1 } }));
                g.DrawImage(image, new Rectangle(0, 0, image.Width, image.Height), 0, 0, image.Width, image.Height, GraphicsUnit.Pixel, attributes);
            }
            image.Dispose();
            brand = new PictureBox { Image = dark, SizeMode = PictureBoxSizeMode.Zoom };
            Put(this, brand, 16, 12, 65, 30);
            var title = Label("模型配置", true);
            Put(this, title, 94, 15, 130, 24);
            mode.TextAlign = ContentAlignment.MiddleRight;
            mode.ForeColor = Color.DimGray;
            Put(this, mode, 302, 15, 148, 24);
            var refresh = Button("刷新", async delegate { if (CanLeave()) await Run(RefreshState); });
            Put(this, refresh, 456, 12, 48, 28);
            tabs.TabPages.AddRange(new[] { library, allocation });
            tabs.SelectedIndex = 0;
            tabs.Padding = new Point(S(26), S(6));
            Put(this, tabs, 12, 56, 496, 250);
            foreach (var page in new[] { library, allocation })
            {
                page.BackColor = Color.White;
                page.AutoScroll = true;
                page.Padding = new Padding(0);
            }
            status.AutoEllipsis = true;
            status.ForeColor = Color.DimGray;
            status.AccessibleName = "操作结果";
            Controls.Add(status);
            tabs.Selecting += delegate (object sender, TabControlCancelEventArgs e)
            {
                if (building)
                    return;
                if (busy || !CanLeave())
                    e.Cancel = true;
                else
                {
                    if (editing)
                    {
                        editing = false;
                        RenderModels();
                    }
                    ResetRules();
                    RenderWindows();
                }
            };
            tabs.SelectedIndexChanged += delegate
            {
                Fit();
            };
            FormClosing += delegate (object sender, FormClosingEventArgs e)
            {
                if (!shuttingDown && (busy || !CanLeave()))
                {
                    e.Cancel = true;
                    if (busy)
                        Notice("请等待当前操作完成后关闭。");
                }
            };
            FormClosed += delegate
            {
                shuttingDown = true;
                poll.Stop();
                poll.Dispose();
                connection.Dispose();
                editor.Secret = "";
                brand.Image.Dispose();
            };
            Shown += delegate
            {
                Fit();
                Console.Out.WriteLine(Json.Codec.Serialize(new
                {
                    ready = true,
                    backendPid = connection.Backend == null ? 0 : connection.Backend.Id
                }));
                Console.Out.Flush();
                if (connection.Attached)
                    ReadCommands();
            };
            poll.Tick += async delegate
            {
                if (polling || busy || disconnected || editing || defaultsDirty)
                    return;
                polling = true;
                try
                {
                    var latest = await connection.Call("/api/state", null);
                    if (busy || editing || defaultsDirty || IsDisposed)
                        return;
                    if (Json.Str(latest, "revision") != Json.Str(state, "revision"))
                    {
                        Notice("配置已被其他窗口修改，请点击刷新加载最新配置。");
                        return;
                    }
                    state = latest;
                    // A native dropdown or focused selection must not be destroyed by polling.
                    if (tabs.SelectedIndex == 1 && !allocation.ContainsFocus)
                    {
                        RenderWindows();
                        Fit();
                    }
                }
                catch { if (IsDisposed || Disposing || shuttingDown) return; disconnected = true; tabs.Enabled = false; mode.Text = "服务已断开"; Notice("配置服务已关闭，请从涌现重新打开。当前草稿仍保留。"); }
                finally { polling = false; }
            };
            ResetRules();
            Render();
            poll.Start();
        }
        int S(int value)
        {
            return (int)Math.Round(value * scale);
        }
        void Put(Control parent, Control child, int x, int y, int width, int height)
        {
            child.SetBounds(S(x), S(y), S(width), S(height));
            parent.Controls.Add(child);
        }
        Label Label(string text, bool bold)
        {
            return new Label { Text = text, AutoEllipsis = true, TextAlign = ContentAlignment.MiddleLeft, Font = new Font(Font, bold ? FontStyle.Bold : FontStyle.Regular), BackColor = Color.Transparent };
        }
        Button Button(string text, EventHandler action)
        {
            var b = new Button { Text = text, UseVisualStyleBackColor = true, AutoEllipsis = true };
            b.Click += action;
            return b;
        }
        void Clear(Control parent)
        {
            while (parent.Controls.Count > 0)
                parent.Controls[0].Dispose();
        }
        void Notice(string text)
        {
            status.Text = text;
            status.AccessibleName = "操作结果：" + text;
        }
        bool CanLeave()
        {
            if (!dirty && !defaultsDirty)
                return true;
            if (MessageBox.Show(this, "有未保存的修改，是否放弃？", "涌现 · 模型配置", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
                return false;
            dirty = false;
            defaultsDirty = false;
            secret = "";
            return true;
        }
        async Task Run(Func<Task> action)
        {
            if (busy || disconnected || shuttingDown || IsDisposed)
                return;
            busy = true;
            tabs.Enabled = false;
            try
            {
                await action();
            }
            catch (Exception error)
            {
                if (!shuttingDown && !IsDisposed && !Disposing)
                    Notice(error is HttpRequestException || error is TaskCanceledException
                        ? "无法连接配置服务，请检查服务状态后重试。" : error.Message);
            }
            finally
            {
                busy = false;
                if (!shuttingDown && !IsDisposed && !Disposing)
                    tabs.Enabled = !disconnected;
            }
        }
        void ResetRules()
        {
            rules = Json.Copy(Json.Get(state, "windowModels"));
            if (Json.Get(rules, "slots") == null)
                rules["slots"] = new Dictionary<string, object>();
            defaultId = Json.Str(state, "defaultModel");
            defaultsDirty = false;
        }
        void Render()
        {
            building = true;
            try
            {
                mode.Text = Json.Yes(state, "live") ? "工作台已连接" : "独立配置";
                RenderModels();
                RenderWindows();
                Fit();
            }
            finally { building = false; }
        }
        void Fit()
        {
            int content = tabs.SelectedIndex == 0 ? modelHeight : windowHeight;
            int target = Math.Min(S(content + 142), Screen.FromControl(this).WorkingArea.Height - S(60));
            ClientSize = new Size(S(520), Math.Max(S(290), target));
            tabs.Height = ClientSize.Height - S(104);
            status.SetBounds(S(16), ClientSize.Height - S(42), S(488), S(34));
            if (Bottom > Screen.FromControl(this).WorkingArea.Bottom)
                Top = Math.Max(Screen.FromControl(this).WorkingArea.Top, Screen.FromControl(this).WorkingArea.Bottom - Height);
        }
        void ReadCommands()
        {
            // Console.In is a synchronized TextReader on Framework: ReadLineAsync can block its caller.
            // Keep pipe reads off the UI thread so the native controls can paint and process input.
            Task.Run(delegate
            {
                try
                {
                    string line;
                    while ((line = Console.In.ReadLine()) != null)
                    {
                        var command = Json.Str(Json.Codec.DeserializeObject(line), "action");
                        if (IsDisposed)
                            return;
                        BeginInvoke((Action)delegate
                        {
                            if (command == "focus")
                            {
                                WindowState = FormWindowState.Normal;
                                Show();
                                SetForegroundWindow(Handle);
                                Activate();
                            }
                            if (command == "close")
                            {
                                shuttingDown = true;
                                Close();
                            }
                        });
                        if (command == "close")
                            return;
                    }
                }
                catch { }
                if (!IsDisposed)
                    try
                    {
                        BeginInvoke((Action)delegate
                        {
                            shuttingDown = true;
                            Close();
                        });
                    }
                    catch { }
            });
        }
    }

}
