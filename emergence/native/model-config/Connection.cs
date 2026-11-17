// Native Windows Forms controls only. No HTML, WebView, browser process or UI dependencies.
// Uses the same authenticated configuration service as the TUI, preserving its validation and DPAPI logic.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace Emergence.ModelConfiguration
{
    sealed class Connection : IDisposable
    {
        private bool disposed;
        internal HttpClient Client;
        internal Process Backend;
        internal bool Attached;
        internal async Task<Dictionary<string, object>> Start(string[] args)
        {
            Attached = args.Contains("--attach");
            string url;
            if (Attached)
            {
                var line = await Console.In.ReadLineAsync();
                url = Json.Str(Json.Codec.DeserializeObject(line ?? "{}"), "url");
            }
            else
            {
                var location = AppDomain.CurrentDomain.BaseDirectory;
                var app = new[] { location, Path.Combine(location, "emergence"), Path.Combine(location, "app"), Path.Combine(location, "..", "..") }
                    .Select(Path.GetFullPath).FirstOrDefault(p => File.Exists(Path.Combine(p, "dist", "cli.mjs")));
                if (app == null)
                    throw new Exception("未找到涌现运行文件，请把此工具保留在涌现项目或发行目录中。");
                var node = new[] { Path.Combine(app, "node_modules", "node", "bin", "node.exe"), Path.Combine(app, "..", "runtime", "node.exe") }.FirstOrDefault(File.Exists);
                if (node == null)
                    throw new Exception("未找到涌现自带的 Node 运行时，请使用完整的涌现安装目录。");
                var arguments = "--experimental-ffi --disable-warning=ExperimentalWarning " + Quote(Path.Combine(app, "dist", "cli.mjs")) + " model-config --native-service";
                for (int i = 0; i < args.Length; i++)
                {
                    if (args[i] == "--home" && i + 1 < args.Length)
                    {
                        arguments += " --home " + Quote(Path.GetFullPath(args[++i]));
                    }
                    else
                        throw new Exception("不支持的启动参数。支持 --home 配置目录。");
                }
                Backend = Process.Start(new ProcessStartInfo(node, arguments)
                {
                    WorkingDirectory = app,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8
                });
                // Drain stderr without persisting credentials or provider diagnostics.
                Backend.ErrorDataReceived += delegate
                {
                };
                Backend.BeginErrorReadLine();
                var read = Backend.StandardOutput.ReadLineAsync();
                if (await Task.WhenAny(read, Task.Delay(15000)) != read)
                    throw new Exception("启动配置服务超时，请检查涌现安装。");
                var line = await read;
                if (line == null)
                    throw new Exception("配置服务未能启动，请检查配置文件或使用 emergence doctor 诊断。");
                url = Json.Str(Json.Codec.DeserializeObject(line), "url");
            }
            Uri address;
            if (!Uri.TryCreate(url, UriKind.Absolute, out address) || address.Scheme != "http" || address.Host != "127.0.0.1" || address.AbsolutePath != "/")
                throw new Exception("配置服务地址无效。");
            var token = address.Fragment.StartsWith("#session=") ? address.Fragment.Substring(9) : "";
            if (!Regex.IsMatch(token, "^[a-f0-9]{64}$"))
                throw new Exception("配置服务会话无效。");
            Client = new HttpClient(new HttpClientHandler { UseProxy = false }) { BaseAddress = new Uri(address.GetLeftPart(UriPartial.Authority)), Timeout = TimeSpan.FromSeconds(30) };
            Client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
            return await Call("/api/state", null);
        }
        internal static string Quote(string value)
        {
            return "\"" + Regex.Replace(Regex.Replace(value, "(\\\\*)\"", "$1$1\\\""), "(\\\\+)$", "$1$1") + "\"";
        }
        internal async Task<Dictionary<string, object>> Call(string path, object body)
        {
            if (disposed)
                throw new ObjectDisposedException("Connection");
            using (var response = body == null ? await Client.GetAsync(path) : await Client.PostAsync(path, new StringContent(Json.Codec.Serialize(body), Encoding.UTF8, "application/json")))
            {
                var payload = await response.Content.ReadAsStringAsync();
                // A response arriving after window shutdown cannot update disposed controls.
                if (disposed)
                    throw new ObjectDisposedException("Connection");
                if (payload.Length > 2097152)
                    throw new Exception("配置服务返回内容过大。");
                var result = Json.Map(Json.Codec.DeserializeObject(payload));
                if (!response.IsSuccessStatusCode)
                    throw new Exception(Json.Str(result, "error"));
                return result;
            }
        }
        public void Dispose()
        {
            if (disposed)
                return;
            disposed = true;
            if (Client != null)
                Client.Dispose();
            if (Backend != null)
            {
                try
                {
                    if (!Backend.HasExited)
                    {
                        Backend.StandardInput.WriteLine("close");
                        Backend.StandardInput.Close();
                        if (!Backend.WaitForExit(3000))
                            Backend.Kill();
                    }
                }
                catch { }
                Backend.Dispose();
            }
        }
    }

}
