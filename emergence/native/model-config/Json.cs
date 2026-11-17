// Native Windows Forms controls only. No HTML, WebView, browser process or UI dependencies.
// Uses the same authenticated configuration service as the TUI, preserving its validation and DPAPI logic.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Web.Script.Serialization;

namespace Emergence.ModelConfiguration
{
    static class Json
    {
        internal static JavaScriptSerializer Codec = new JavaScriptSerializer { MaxJsonLength = 2097152 };
        internal static Dictionary<string, object> Map(object value)
        {
            return value as Dictionary<string, object> ?? new Dictionary<string, object>();
        }
        internal static object Get(object value, string key)
        {
            object result;
            return Map(value).TryGetValue(key, out result) ? result : null;
        }
        internal static string Str(object value, string key)
        {
            return Convert.ToString(Get(value, key)) ?? "";
        }
        internal static bool Yes(object value, string key)
        {
            return Get(value, key) is bool && (bool)Get(value, key);
        }
        internal static IEnumerable<Dictionary<string, object>> Rows(object value, string key)
        {
            var rows = Get(value, key) as IEnumerable;
            return rows == null ? Enumerable.Empty<Dictionary<string, object>>() : rows.Cast<object>().Select(Map);
        }
        internal static Dictionary<string, object> Copy(object value)
        {
            return Map(Codec.DeserializeObject(Codec.Serialize(value)));
        }
    }

}
