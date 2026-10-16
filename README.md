# openrouter-mcp

خادم MCP على Cloudflare Workers يفحص نماذج OpenRouter يوميًا ويعرض الأدوات لـ Muse.

## الأدوات

- `daily_report`: آخر تقرير يومي (جديد/محذوف/تغيّر أسعار/تحوّل مجاني + لقطة الحصة)
- `models_search`, `model_info`: قراءة من الكتالوج (بلا استهلاك حصة)
- `quota`: قسم مالي وقسم الطلبات المجانية منفصلان
- `live_ping`: اختبار حي لنموذج `:free` فقط. الحد الأقصى 3 باليوم ويُفرض بالخادم. أبقِه خارج ALLOWED_TOOLS في Muse في البداية.

## الإعداد (مرة واحدة)

1. من لوحة Cloudflare: Workers KV ثم Create namespace، وانسخ المعرّف إلى `wrangler.toml`.
2. أسرار الريبو (Settings ثم Secrets and variables ثم Actions):
   - `CLOUDFLARE_API_TOKEN` (صلاحية Workers فقط)
   - `CLOUDFLARE_ACCOUNT_ID`
   - `OPENROUTER_API_KEY` (مفتاح مخصص بسقف إنفاق صغير)
   - `MCP_TOKEN` (نص عشوائي طويل، 32 حرفًا فأكثر)
3. ادفع الملفات إلى `main`، فيُنشر الـ Worker تلقائيًا ويُرفع السرّان إلى الـ Worker.
4. في Muse سجّل اعتمادًا جديدًا (Bearer) بقيمة `MCP_TOKEN` للمضيف `*.workers.dev`، وأضف الرابط `https://openrouter-mcp.<subdomain>.workers.dev/mcp`.
