const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url'); // استخدام URL لتحليل الروابط بشكل صحيح


// --- الإعدادات ---
// هذا التوكن (Token) راح ناخذه من Vercel Environment Variables (متغيرات البيئة)
// لا تخليه مباشرة هنا بالكود
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; 
const BASE_URL = "https://www.hindawi.org";
const SEARCH_URL_TEMPLATE = `${BASE_URL}/search/keyword/{query}/`;

// تهيئة البوت بوضع الـ webhook (polling: false) ليتناسب مع Vercel
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });


const lastBotMessageIds = {}; // chat_id -> message_id

async function deleteBotPreviousMessage(chatId, messageId) {
    if (!messageId) return;
    try {
        await bot.deleteMessage(chatId, messageId);
    } catch (error) {
        // الأخطاء هنا تكون غالباً بسبب إن الرسالة قديمة أو محذوفة، فنكتفي بتسجيلها في اللوغات
        console.error(`فشل حذف رسالة ${messageId} في الشات ${chatId}:`, error.message);
    }
}

// دالة مساعدة لإرسال رسالة البوت وحفظ الـ ID لحذفها لاحقاً
async function sendAndStoreMessage(chatId, text, options = {}) {
    const sentMessage = await bot.sendMessage(chatId, text, options);
    lastBotMessageIds[chatId] = sentMessage.message_id;
    return sentMessage;
}


// --- الدالة الرئيسية اللي تستقبل طلبات الـ Webhook من Vercel ---
module.exports = async (req, res) => {
    // التأكد إن الطلب جاي بطريقة POST
    if (req.method !== 'POST') {
        return res.status(405).send('Method Not Allowed');
    }

    const update = req.body; // التحديث اللي جاي من التليجرام

    try {
        if (update.message) {
            // لمن تجينا رسالة، نحذف رسالة البوت السابقة (إذا كانت موجودة)
            await deleteBotPreviousMessage(update.message.chat.id, lastBotMessageIds[update.message.chat.id]);
            await handleMessage(update.message);
        } else if (update.callback_query) {
            // لمن يختار المستخدم زر، نحذف الرسالة اللي بيها الأزرار
            await deleteBotPreviousMessage(update.callback_query.message.chat.id, update.callback_query.message.message_id);
            await handleCallbackQuery(update.callback_query);
        }
    } catch (error) {
        console.error("خطأ بمعالجة التحديث:", error); 
    }

    // دائماً ارجع 200 OK للتليجرام بسرعة حتى يعرف إنك استلمت التحديث
    res.status(200).send('OK');
};

// --- معالج الرسائل العادية (مثل /start, /search, أو اسم الكتاب) ---
async function handleMessage(message) {
    const chatId = message.chat.id;
    const text = message.text;

    if (text === '/start' || text === '/help') {
        await sendAndStoreMessage(chatId, "هلا بيك!");
    } else if (text === '/search') {
        await sendAndStoreMessage(chatId, "دزلي اسم الكتاب.");
    } else if (text === '/cancel') {
        delete lastBotMessageIds[chatId]; 
        await sendAndStoreMessage(chatId, "لغيت.");
    } else {
        // إذا مو أمر، نعتبره اسم كتاب للبحث
        await handleBookSearch(message);
    }
}

// --- معالج استدعاءات الأزرار (Inline Keyboards) ---
async function handleCallbackQuery(callbackQuery) {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data; 

    // رد على التليجرام فوراً حتى تختفي علامة التحميل من الزر
    await bot.answerCallbackQuery(callbackQuery.id);

    try {
        // البيانات تكون على شكل 'action:value'
        const [action, value] = data.split(':');

        if (action === 'book') {
            // value هو رابط الكتاب
            await handleBookChoice(chatId, value); 
        } else if (action === 'format') {
            // value هو 'رابط_الكتاب|رابط_الصيغة'
            const [bookUrl, formatUrl] = value.split('|');
            await handleFormatChoiceAndDownload(chatId, bookUrl, formatUrl);
        } else if (action === 'cancel_search') {
            await sendAndStoreMessage(chatId, "لغيت البحث.");
        } else {
            // حدث غير معروف
            await sendAndStoreMessage(chatId, "صار غلط.");
        }
    } catch (error) {
        console.error("خطأ بمعالج استدعاء الزر:", error);
        await sendAndStoreMessage(chatId, "صار غلط.");
    }
}

// --- منطق البوت الأساسي ---

async function handleBookSearch(message) {
    const chatId = message.chat.id;
    const bookName = message.text.trim();

    if (!bookName) {
        await sendAndStoreMessage(chatId, "دز اسم كتاب.");
        return;
    }

    const encodedBookName = encodeURIComponent(bookName);
    const searchUrl = SEARCH_URL_TEMPLATE.replace('{query}', encodedBookName);

    await sendAndStoreMessage(chatId, `دا أبحث عن '${bookName}'...`);

    try {
        // timeout 30 ثانية لطلب البحث
        const response = await axios.get(searchUrl, { timeout: 30000 }); 
        const $ = cheerio.load(response.data); // تحميل HTML للتحليل باستخدام Cheerio

        const foundBooks = [];
        // البحث عن روابط الكتب
        $('a[href^="/books/"]').each((i, linkTag) => {
            const href = $(linkTag).attr('href');
            // استخدام التعبير النمطي لضمان إنها روابط صفحات كتب فعلية
            if (href && /^\/books\/\d{6,}\/$/.test(href)) {
                const fullUrl = new URL(href, BASE_URL).href;
                let bookTitleFromSearch = $(linkTag).text().trim();

                // محاولة استخلاص العنوان من alt للصورة إذا النص فارغ أو يحتوي على "كتاب بعنوان"
                if (!bookTitleFromSearch || bookTitleFromSearch.includes("كتاب بعنوان")) {
                    const imgTag = $(linkTag).find('img[alt]');
                    if (imgTag.length && imgTag.attr('alt')) {
                        bookTitleFromSearch = imgTag.attr('alt').replace(' كتاب بعنوان ', '').trim();
                    }
                }

                if (!bookTitleFromSearch) {
                    // محاولة استخلاص اسم من الرابط إذا لم يتوفر
                    const parts = href.split('/').filter(Boolean);
                    bookTitleFromSearch = parts[parts.length - 1] || 'كتاب بدون عنوان';
                }

                // تجنب التكرارات
                if (!foundBooks.some(book => book.url === fullUrl)) {
                    foundBooks.push({ url: fullUrl, title: bookTitleFromSearch });
                }
            }
        });

        if (foundBooks.length === 0) {
            await sendAndStoreMessage(chatId, "ما لكيت.");
            return;
        }

        // بناء Inline Keyboard (أزرار تحت الرسالة) لكل كتاب
        const inlineKeyboard = foundBooks.map((book, i) => ([
            { text: `${i + 1}. ${book.title}`, callback_data: `book:${book.url}` } // نرسل رابط الكتاب في الـ callback_data
        ]));
        // إضافة زر "إلغاء"
        inlineKeyboard.push([{ text: "0. إلغاء", callback_data: "cancel_search" }]);

        await sendAndStoreMessage(chatId, "لكيت:\nاختار الكتاب:", {
            reply_markup: {
                inline_keyboard: inlineKeyboard
            }
        });

    } catch (error) {
        console.error("خطأ بالبحث عن الكتاب:", error);
        let errorMessage = "صار غلط بالبحث.";
        if (error.code === 'ECONNABORTED' || error.name === 'TimeoutError') {
             errorMessage = "صار غلط بالبحث (مهلة اتصال). يجوز الإنترنت ضعيف.";
        }
        await sendAndStoreMessage(chatId, errorMessage);
    }
}

async function handleBookChoice(chatId, bookUrl) {
    // إذا المستخدم داس على "إلغاء البحث"
    if (bookUrl === 'cancel_search') {
        await sendAndStoreMessage(chatId, "لغيت.");
        return;
    }

    await sendAndStoreMessage(chatId, "دا أجيب تفاصيل.");

    try {
        // timeout 30 ثانية لطلب جلب تفاصيل الكتاب
        const response = await axios.get(bookUrl, { timeout: 30000 }); 
        const $ = cheerio.load(response.data);

        let actualBookTitle = "كتاب_ماكو_عنوان";
        const titleTag = $('title').text();
        if (titleTag) {
            actualBookTitle = titleTag.replace(' | مؤسسة هنداوي', '').trim();
            // إزالة الأحرف غير المسموح بها بأسماء الملفات
            actualBookTitle = actualBookTitle.replace(/[\\/:*?"<>|]/g, ''); 
        }

        const availableFormats = [];
        $('a[href]').each((i, dlTag) => {
            const dlHref = $(dlTag).attr('href');
            if (dlHref && (dlHref.endsWith('.pdf') || dlHref.endsWith('.epub') || dlHref.endsWith('.kfx'))) {
                const formatName = dlHref.split('.').pop().toUpperCase();
                const fullDlUrl = new URL(dlHref, BASE_URL).href;
                availableFormats.push({ name: formatName, url: fullDlUrl });
            }
        });

        if (availableFormats.length === 0) {
            await sendAndStoreMessage(chatId, "ماكو صيغ.");
            return;
        }

        // بناء Inline Keyboard بأزرار لكل صيغة
        const inlineKeyboard = availableFormats.map((format, i) => ([
            { text: `${i + 1}. ${format.name}`, callback_data: `format:${bookUrl}|${format.url}` } // نرسل رابط الكتاب ورابط الصيغة
        ]));

        await sendAndStoreMessage(chatId, "هاي الصيغ:", {
            reply_markup: {
                inline_keyboard: inlineKeyboard
            }
        });

    } catch (error) {
        console.error("خطأ بجلب تفاصيل الكتاب:", error);
        let errorMessage = "صار غلط بجلب التفاصيل.";
        if (error.code === 'ECONNABORTED' || error.name === 'TimeoutError') {
             errorMessage = "صار غلط بجلب التفاصيل (مهلة اتصال). يجوز الإنترنت ضعيف.";
        }
        await sendAndStoreMessage(chatId, errorMessage);
    }
}

async function handleFormatChoiceAndDownload(chatId, bookUrl, formatUrl) {
    await sendAndStoreMessage(chatId, "دا أحمل... صبر.");

    try {
        // تحميل الملف مباشرة إلى الذاكرة كـ Buffer
        const fileResponse = await axios.get(formatUrl, {
            responseType: 'arraybuffer', // الحصول على البيانات كـ Buffer
            timeout: 120000 // 120 ثانية timeout للتحميل
        });

        const fileData = Buffer.from(fileResponse.data); // البيانات الخام للملف

        // محاولة جلب اسم الكتاب مرة أخرى أو استخدام اسم افتراضي
        let actualBookTitle = "كتاب_ماكو_عنوان";
        try {
             const urlSegments = bookUrl.split('/').filter(s => s.length > 0);
             if (urlSegments.length > 0) {
                 actualBookTitle = decodeURIComponent(urlSegments[urlSegments.length - 1]);
                 actualBookTitle = actualBookTitle.replace(/[\\/:*?"<>|]/g, '');
             }
        } catch (err) {
             console.error("فشل استخلاص عنوان الكتاب من الرابط:", err);
        }

        // الحصول على يوزر البوت
        let botUsername = '@yourHindawiBot'; 
        try {
            const botInfo = await bot.getMe();
            botUsername = `@${botInfo.username}` || "البوت";
        } catch (e) {
             console.error("فشل جلب معلومات البوت:", e.message);
        }

        const captionText = `${botUsername} ⬇️`;
        const fileExtension = formatUrl.split('.').pop().toLowerCase();
        const fileName = `${actualBookTitle}.${fileExtension}`; 

        // إرسال الملف من الذاكرة مباشرة
        await bot.sendDocument(chatId, fileData, {
            caption: captionText,
            fileName: fileName, // اسم الملف اللي راح يظهر للمستخدم
            timeout: 120000 // 120 ثانية timeout للإرسال للتليجرام
        });

        await sendAndStoreMessage(chatId, " الكتاب نزل تابع تحديثات المطور @DevAkhbari !");

    } catch (error) {
        console.error("خطأ وقت اختيار الصيغة والتحميل:", error);
        let userMessage = "صار غلط."; 

        if (error.response && error.response.status === 413) { 
            userMessage = `الكتاب جبير كلش (حجمه حوالي ${fileData ? (fileData.length / (1024*1024)).toFixed(2) + " ميجابايت" : "غير معروف"}) ما يندز.`;
        } else if (error.code === 'ECONNABORTED' || error.name === 'TimeoutError' || (error.response && error.response.status === 504)) {
            userMessage = "صار غلط وقت إرسال الكتاب، يجوز الكتاب جبير كلش وما كدرت أدزه.";
        } else {
            userMessage = "صار غلط، حاول مرة ثانية.";
        }
        await sendAndStoreMessage(chatId, userMessage);
    }
}
