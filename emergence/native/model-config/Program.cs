// Native Windows Forms controls only. No HTML, WebView, browser process or UI dependencies.
// Uses the same authenticated configuration service as the TUI, preserving its validation and DPAPI logic.

using System;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace Emergence.ModelConfiguration
{
    static class Program
    {
        [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("shell32.dll")] static extern int SetCurrentProcessExplicitAppUserModelID(string id);
        [STAThread]
        static void Main(string[] args)
        {
            try
            {
                SetProcessDpiAwarenessContext(new IntPtr(-4));
            }
            catch (EntryPointNotFoundException) { }
            SetCurrentProcessExplicitAppUserModelID("Emergence.ModelConfiguration");
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            // WinExe has no console; use redirected pipe streams without calling console code-page APIs.
            Console.SetIn(new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)));
            Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
            Console.SetError(new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)) { AutoFlush = true });
            using (var connection = new Connection())
            {
                try
                {
                    // Bootstrap before creating controls; Start uses no UI synchronization context.
                    var state = connection.Start(args).GetAwaiter().GetResult();
                    Application.Run(new ConfigurationForm(connection, state));
                }
                catch (Exception error)
                {
                    if (args.Contains("--attach"))
                        Console.Error.WriteLine("无法启动原生模型配置窗口：" + error.Message);
                    else
                        MessageBox.Show("无法打开模型配置：" + error.Message, "涌现 · 模型配置", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    Environment.ExitCode = 1;
                }
            }
        }
    }

}
