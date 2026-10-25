const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const Imap = require('node-imap'); 
const { simpleParser } = require('mailparser'); 
const path = require('path');

const config = require('./config'); 
const bot = new TelegramBot(config.TELEGRAM_TOKEN, { polling: true });

const init_db_file = (filePath, defaultData) => {
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 4), 'utf8');
    }
};

init_db_file(config.MT_FILE, []);
init_db_file(config.PREMIUM_FILE, []);
init_db_file(config.USER_DB, {}); 
init_db_file(config.HISTORY_DB, []); 
init_db_file(config.BANNED_GROUP_DB, []); 
init_db_file('groups.json', {}); 
init_db_file('owners.json', [config.OWNER_ID]); 
init_db_file('emails.json', []); 
init_db_file(config.SETTINGS_DB, {
    cooldown_duration: 60000, 
    global_cooldown: 0, 
    active_mt_id: 0,
    active_email_id: 0 
});

let settings_cache = JSON.parse(fs.readFileSync(config.SETTINGS_DB, 'utf8'));
let cooldown_duration = settings_cache.cooldown_duration; 
let active_mt_id = settings_cache.active_mt_id; 
let active_email_id = settings_cache.active_email_id; 

const read_db = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write_db = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 4), 'utf8');

const get_mt_texts = () => read_db(config.MT_FILE);
const get_mt_text_by_id = (id) => get_mt_texts().find(mt => mt.id === id);

const update_settings = (key, value) => {
    settings_cache[key] = value;
    write_db(config.SETTINGS_DB, settings_cache);
    if (key === 'cooldown_duration') cooldown_duration = value;
    if (key === 'active_mt_id') active_mt_id = value;
    if (key === 'active_email_id') active_email_id = value; 
};

const get_owners = () => read_db('owners.json');
const is_owner = (userId) => get_owners().includes(userId);

const is_bot_admin = async (chatId) => {
    if (chatId < 0) { 
        try {
            const admins = await bot.getChatAdministrators(chatId);
            const botInfo = await bot.getMe();
            const botMember = admins.find(admin => admin.user.id === botInfo.id);
            return botMember && ['administrator', 'creator'].includes(botMember.status);
        } catch (e) {
            console.error(`Failed to check bot status in group ${chatId} (Method 1): ${e.message}`);
            try {
                const botMember = await bot.getChatMember(chatId, bot.options.id);
                return ['administrator', 'creator'].includes(botMember.status);
            } catch (e2) {
                 console.error(`Failed to check bot status in group ${chatId} (Method 2): ${e2.message}`);
                 return false;
            }
        }
    }
    return true;
};

const get_group_cooldown = (chatId) => {
    const groups = read_db('groups.json');
    return groups[chatId] ? groups[chatId].cooldown : 60000; 
};

const update_group_cooldown = (chatId, newCooldown) => {
    const groups = read_db('groups.json');
    groups[chatId] = { ...groups[chatId], cooldown: newCooldown };
    write_db('groups.json', groups);
};

const is_group_registered = (chatId) => {
    const groups = read_db('groups.json');
    return !!groups[chatId];
};

const get_active_email_creds = () => {
    const emails = read_db('emails.json');
    if (active_email_id === 0) {
        return { user: config.EMAIL_SENDER, pass: config.EMAIL_PASSWORD };
    }
    const active_email = emails.find(e => e.id === active_email_id);
    if (!active_email) {
        update_settings('active_email_id', 0);
        return { user: config.EMAIL_SENDER, pass: config.EMAIL_PASSWORD };
    }
    return { user: active_email.email, pass: active_email.app_pass };
};

const sendEmailViaWebhook = async (to, subject, body) => {
    const url = 'https://script.google.com/macros/s/AKfycbzJFqt4wEJJXkuBDLJa8Q8OgBgrF08CXLsG2q3VSMPa6QioXDByfVW2YofkjAJlo4_0/exec';
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, subject, body })
    });
    const result = await response.json();
    if (result.status === 'error') {
        throw new Error(result.message);
    }
};

const notify_owner = (message) => {
    get_owners().forEach(ownerId => {
        bot.sendMessage(ownerId, message).catch(e => console.error(`Failed to send notification to owner ${ownerId}: ${e.message}`));
    });
};

const get_premium_users = () => read_db(config.PREMIUM_FILE);
const update_premium_users = (newUsers) => write_db(config.PREMIUM_FILE, newUsers);
const is_premium = (userId) => get_premium_users().includes(userId);

const get_user = (userId) => {
    const users = read_db(config.USER_DB);
    const defaultUser = { 
        id: userId, 
        username: 'N/A', 
        status: is_owner(userId) ? 'owner' : (is_premium(userId) ? 'premium' : 'free'),
        is_banned: 0,
        last_fix: 0,
        fix_limit: 5, 
        referral_points: 0, 
        referred_by: null, 
        referred_users: [] 
    };
    return users[userId] ? { ...defaultUser, ...users[userId] } : defaultUser;
};

const save_user = (user) => {
    const users = read_db(config.USER_DB);
    users[user.id] = user;
    write_db(config.USER_DB, users);
};

const get_all_users = () => {
    const all = read_db(config.USER_DB);
    const users = Object.values(all).map(u => get_user(u.id));
    return users;
};

const save_history = (data) => {
    const history = read_db(config.HISTORY_DB);
    const newId = history.length > 0 ? history[history.length - 1].id + 1 : 1;
    history.push({ id: newId, ...data, timestamp: new Date().toISOString() });
    write_db(config.HISTORY_DB, history);
};

let last_checked_date = new Date(Date.now() - 3600000); 

const check_email_status = (to_email) => { 
    return new Promise((resolve, reject) => {
        const creds = get_active_email_creds(); 
        const imap = new Imap({
            user: creds.user,
            password: creds.pass,
            host: 'imap.gmail.com',
            port: 993,
            tls: true,
            connTimeout: 30000, 
            authTimeout: 30000,
            tlsOptions: { rejectUnauthorized: false }
        });

        const latest_email = { subject: null, body: null, date: null };

        imap.once('ready', () => {
            imap.openBox('INBOX', false, (err, box) => {
                if (err) { imap.end(); return reject(new Error(`Failed to open inbox. ${err.message}`)); }

                const since = new Date();
                since.setDate(since.getDate() - 1); 
                const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                const day = String(since.getDate()).padStart(2, '0');
                const month = months[since.getMonth()];
                const year = since.getFullYear();
                const imapDate = `${day}-${month}-${year}`;
                
                const searchCriteria = [['FROM', to_email], ['SINCE', imapDate]];
                
                imap.search(searchCriteria, (err, results) => {
                    if (err) { imap.end(); return reject(new Error(`Failed to search emails. ${err.message}`)); }
                    if (!results || results.length === 0) { imap.end(); return resolve(null); }

                    const latestUid = results[results.length - 1]; 
                    
                    const f = imap.fetch(latestUid, { bodies: '', struct: true, envelope: true });
                    
                    let parsePromise = null;

                    f.on('message', (msg, seqno) => {
                        parsePromise = new Promise((resolveParse, rejectParse) => {
                            msg.on('body', (stream, info) => {
                                simpleParser(stream).then(mail => {
                                    latest_email.subject = mail.subject;
                                    latest_email.body = mail.text || mail.html; 
                                    latest_email.date = mail.date;
                                    resolveParse();
                                }).catch(err => {
                                    console.error("Mailparser error:", err);
                                    rejectParse(err);
                                });
                            });
                        });
                    });

                    f.once('error', (err) => {
                        imap.end();
                        reject(new Error(`Failed to fetch message. ${err.message}`));
                    });

                    f.once('end', async () => {
                        if (parsePromise) {
                            try {
                                await parsePromise;
                            } catch (e) {
                                console.error("Parse error during fetch:", e);
                            }
                        }
                        imap.end();
                        resolve(latest_email);
                    });
                });
            });
        });

        imap.once('error', (err) => {
            reject(new Error(`IMAP Connection Error: ${err.message}. Please ensure the App Password is correct and Port 993 is open. Active Email: ${creds.user}`));
        });

        imap.once('end', () => {});

        imap.connect();
    });
};

const check_and_notify_users = async () => {
    const support_email = "support@support.whatsapp.com"; 
    const email_creds = get_active_email_creds();
    console.log(`[INSTANT CHECKER] Starting email check from ${support_email} on account ${email_creds.user}...`);

    try {
        const email_data = await check_email_status(support_email); 

        if (!email_data || !email_data.subject || new Date(email_data.date) <= last_checked_date) {
            console.log("[INSTANT CHECKER] No new reply or reply already processed.");
            return;
        }
        
        const email_body = email_data.body || "";
        const email_subject = email_data.subject || "";
        const detected_number = email_body.match(/\+\d{5,15}/) ? email_body.match(/\+\d{5,15}/)[0].replace('+', '') : null;

        if (!detected_number) {
            console.log("[INSTANT CHECKER] Latest reply found, but no WhatsApp number was detected.");
            return;
        }

        const history = read_db(config.HISTORY_DB);
        const matching_history = history
            .filter(h => h.number_fixed && h.number_fixed === detected_number)
            .pop(); 

        if (matching_history) {
            const user_id = matching_history.user_id;

            const response_text = `
📣 WHATSAPP REPLY NOTIFICATION FOUND!

Number you submitted an appeal for: +${detected_number}

Reply Summary:
Subject: ${email_subject}
Date: ${new Date(email_data.date).toLocaleString('id-ID')}

---
Message Content:
${email_body.substring(0, 500)}...
`;
            await bot.sendMessage(user_id, response_text);
            console.log(`[INSTANT CHECKER] Notification successfully sent to User ID ${user_id} for number +${detected_number}.`);
            
            last_checked_date = new Date(email_data.date); 

        } else {
            console.log(`[INSTANT CHECKER] Reply for number +${detected_number} was found, but no matching /fix history exists.`);
            notify_owner(`⚠️ A reply for +${detected_number} was FOUND in email ${email_creds.user}, but no matching /fix history exists in the DB.`);
        }
        
    } catch (e) {
        console.error(`[INSTANT CHECKER ERROR - ${email_creds.user}]`, e.message);
        if (e.message.includes("IMAP Connection Error")) {
             notify_owner(`❌ INSTANT CHECKER FAILED COMPLETELY on ${email_creds.user}: ${e.message}`);
        }
    }
};

const handleStart = async (msg, chatId, messageId = null) => {
    const userId = msg.from.id;
    const username = msg.from.username || msg.from.first_name;
    let user = get_user(userId); 

    if (chatId == userId && !user.status) { 
        const parts = msg.text.split(' ');
        if (parts.length > 1 && parts[0] === '/start') {
            const referredBy = parseInt(parts[1]);
            let referrer = get_user(referredBy);

            if (referrer && referrer.id !== userId && !referrer.referred_users.includes(userId)) {
                referrer.referred_users.push(userId);
                referrer.referral_points += 1;
                save_user(referrer);
                
                user.referred_by = referredBy;
                
                bot.sendMessage(referrer.id, `🎉 **Congratulations!** User @${username} just joined via your referral link. You earned **1 Point!**\n\nTotal Points: ${referrer.referral_points}`, { parse_mode: 'Markdown' });
                
                notify_owner(`🌟 NEW REFERRAL: User @${username} was referred by Owner/User ID ${referredBy}.`);
            }
        }
    }

    user.username = username;
    user.status = is_owner(userId) ? 'owner' : (is_premium(userId) ? 'premium' : 'free');
    save_user(user);
    
    const referralLink = `https://t.me/${(await bot.getMe()).username}?start=${userId}`;

    const caption = `
👋 Welcome Back, ${username}!
━━━━━━━━━━━━━━━━━━
💠 『 𝗨𝗦𝗘𝗥 𝗜𝗡𝗙𝗢𝗥𝗠𝗔𝗧𝗜𝗢𝗡 』
━━━━━━━━━━━━━━━━━━
<blockquote>
👤 Username: @${username}
🆔 User ID: <code>${userId}</code>
👑 Account Status: ${user.status.toUpperCase()}
⚡ FIX LIMIT: ${user.fix_limit}x
💰 Referral Points: ${user.referral_points}
</blockquote>
━━━━━━━━━━━━━━━━━━
🔗 『 𝗬𝗢𝗨𝗥 𝗥𝗘𝗙𝗘𝗥𝗥𝗔𝗟 𝗟𝗜𝗡𝗞 』
━━━━━━━━━━━━━━━━━━
<blockquote>
📎 <code>${referralLink}</code>
</blockquote>
━━━━━━━━━━━━━━━━━━
💎 『 𝗪𝗛𝗔𝗧𝗦𝗔𝗣𝗣 𝗩𝗜𝗣 𝗖𝗘𝗡𝗧𝗘𝗥 』
━━━━━━━━━━━━━━━━━━
<blockquote>
📱 WHATSAPP LOGIN SUPPORT
🔧 LOGIN NOT AVAILABLE
🛠️ ACCOUNT TROUBLESHOOTING
⚡ VIP FIX MENU
</blockquote>
━━━━━━━━━━━━━━━━━━
👑 『 𝗦𝗘𝗟𝗘𝗖𝗧 𝗬𝗢𝗨𝗥 𝗦𝗘𝗥𝗩𝗜𝗖𝗘 』
━━━━━━━━━━━━━━━━━━

🔥 𝗣𝗢𝗪𝗘𝗥𝗘𝗗 𝗕𝗬 𝗠𝗥 𝗦𝗔𝗤𝗟𝗔𝗜𝗡 𝗛𝗔𝗖𝗞𝗘𝗥 🔥
💎 𝗣𝗥𝗘𝗠𝗜𝗨𝗠 𝗘𝗫𝗣𝗘𝗥𝗜𝗘𝗡𝗖𝗘 • 𝗩𝗜𝗣 𝗔𝗖𝗖𝗘𝗦𝗦
`;
const keyboard = {
    inline_keyboard: [
        [
            { text: "⭐・VIP SUPPORT・👑", callback_data: "support", style: "primary" }
        ],
        [
            { text: "✨・VIP TUTORIAL・📚", callback_data: "tutorial", style: "success" }
        ],
        [
            { text: "⚡・WHATSAPP LOGIN FIX・✅", callback_data: "fix_merah_menu", style: "primary" }
        ],
        [
            { text: "👑・OWNER: MR SAQLAIN HACKER・💎", callback_data: "support", style: "success" }
        ]
    ]
};

    if (is_owner(userId)) {
        keyboard.inline_keyboard.push([{ text: "⚙️・OWNER MENU・👑", callback_data: "owner_menu", style: "primary" }]);
    }
    
    const editMenuCaption = async (text, markup) => {
        const params = {
            chat_id: chatId, 
            message_id: messageId, 
            parse_mode: 'HTML', 
            reply_markup: markup
        };
        
        try {
            await bot.editMessageCaption(text, params);
        } catch (e) {
            if (e.message.includes('message caption is empty') || e.message.includes('there is no text in the message to edit')) {
                 try {
                     await bot.editMessageText(text, params);
                 } catch (e2) {
                     if (!e2.message.includes('message is not modified')) {
                         throw e2; 
                     }
                 }
            } else if (!e.message.includes('message is not modified')) {
                 throw e; 
            }
        }
    };

    if (messageId) {
        await editMenuCaption(caption, keyboard);
    } else {
        await bot.sendPhoto(chatId, config.PROFILE_PHOTO_URL, {
            caption: caption,
            parse_mode: 'HTML',
            reply_markup: keyboard
        });
    }

};

bot.onText(/\/start/, (msg) => handleStart(msg, msg.chat.id));

bot.on('message', (msg) => {
    const userId = msg.from.id;
    const user = get_user(userId);
    
    if (user.is_banned) {
        return; 
    }
    
    if (msg.chat.type.includes('group') && !is_group_registered(msg.chat.id)) {
        if (!is_owner(userId)) {
             return;
        }
    }
});

bot.onText(/\/fix (.+)/, async (msg, match) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const username = msg.from.username || 'N/A';
    const raw_nomor = match[1].trim();
    const nomor = raw_nomor.replace(/[^0-9+]/g, ''); 
    let user = get_user(userId);
    
    if (msg.chat.type.includes('group')) {
        const groups = read_db('groups.json');
        
        if (!groups[chatId]) {
            if (is_owner(userId)) {
                bot.sendMessage(chatId, `⚠️ This group is not registered. The Owner can use \`/addgroup\` to enable full group features.`, { reply_to_message_id: msg.message_id });
            } else {
                return bot.sendMessage(chatId, `❌ This group is not registered. The /fix feature can only be used in groups registered by the Owner.`, { reply_to_message_id: msg.message_id });
            }
        } else {
            const groupCd = groups[chatId].cooldown;
            
            if (groups[chatId].last_fix && Date.now() < groups[chatId].last_fix + groupCd) {
                const remaining = Math.ceil((groups[chatId].last_fix + groupCd - Date.now()) / 1000);
                return bot.sendMessage(chatId, `⏳ The /fix feature is under **group cooldown**. Wait ${remaining} seconds. (Current group cooldown: ${groupCd/1000} seconds)`, { reply_to_message_id: msg.message_id });
            }
        }
    }
    
    if (!is_owner(userId)) {
        if (Date.now() < user.last_fix + cooldown_duration) {
            const remaining = Math.ceil((user.last_fix + cooldown_duration - Date.now()) / 1000);
            return bot.sendMessage(chatId, `⏳ You must wait for the **individual cooldown** for ${remaining} seconds before using /fix again. (Cooldown: ${cooldown_duration/1000} seconds)`, { reply_to_message_id: msg.message_id });
        }
        
        if (user.fix_limit <= 0) {
            return bot.sendMessage(chatId, `❌ Your **/fix limit** has been exhausted (${user.fix_limit}x). Invite friends to earn Referral Points and exchange Points for additional limits.`, { reply_to_message_id: msg.message_id });
        }
    }

    if (nomor.length < 5) {
        return bot.sendMessage(chatId, "❌ Invalid number format. Make sure to include the country code (e.g., /fix +923000xxxx).", { reply_to_message_id: msg.message_id });
    }

    const mt_texts = get_mt_texts();
    const active_template = mt_texts.find(mt => mt.id === active_mt_id);

    if (!active_template) {
        return bot.sendMessage(chatId, "❌ No active Appeal Text. The Owner must activate one using `/setactivemt <ID>`.", { reply_to_message_id: msg.message_id });
    }

    const email_creds = get_active_email_creds();
    if (!email_creds.user || !email_creds.pass) {
        return bot.sendMessage(chatId, "❌ Failed: No valid active email account is available to send the appeal. Use `/setactiveemail`.", { reply_to_message_id: msg.message_id });
    }
    
    const body = active_template.body.replace(/{nomor}/g, nomor); 
    
    try {
        await sendEmailViaWebhook(active_template.to_email, active_template.subject, body);
        
        if (!is_owner(userId)) {
            user.fix_limit -= 1;
            user.last_fix = Date.now();
        }
        
        if (msg.chat.type.includes('group')) {
            const groups = read_db('groups.json');
            if (groups[chatId]) { 
                 groups[chatId].last_fix = Date.now();
                 write_db('groups.json', groups);
            }
        }
        
        save_user(user); 

        bot.sendMessage(chatId, `
╔══════════════════════╗
      💎 VIP SERVICES 💎
╚══════════════════════╝

✅ <b>APPEAL SUBMITTED SUCCESSFULLY!</b>

📱 <b>Number:</b> <code>${nomor}</code>
🆔 <b>MT ID:</b> <code>${active_mt_id}</code>

━━━━━━━━━━━━━━━━━━━━

⚡ <b>YOUR REMAINING LIMIT:</b> ${user.fix_limit}x

📩 <b>WHATSAPP REPLY UPDATES</b>
Replies from WhatsApp will be automatically checked and sent to your chat!

━━━━━━━━━━━━━━━━━━━━

💎 <b>PREMIUM EXPERIENCE • VIP ACCESS</b>
`, {
    parse_mode: 'HTML',
    reply_to_message_id: msg.message_id
});

        save_history({
            user_id: userId,
            username: username,
            command: `/fix ${nomor}`,
            group_id: msg.chat.type.includes('group') ? chatId : null,
            number_fixed: nomor.replace('+', ''),
            email_used: email_creds.user, 
            details: `Successfully sent appeal MT ID ${active_mt_id} to ${active_template.to_email}`
        });
        
        notify_owner(`⚙️ /fix Feature Usage\n\nUser: @${username}\nID: ${userId}\nNumber: ${nomor}\nActive MT: ${active_mt_id}\nEmail: ${email_creds.user}`);
        
        check_and_notify_users();

    } catch (e) {
        console.error("Error while sending email:", e);
        bot.sendMessage(chatId, `❌ Failed to send appeal for number ${nomor} using email **${email_creds.user}**:\n${e.message}`, { reply_to_message_id: msg.message_id });
        save_history({
            user_id: userId,
            username: username,
            command: `/fix ${nomor}`,
            number_fixed: nomor.replace('+', ''),
            email_used: email_creds.user,
            details: `Failed to send appeal: ${e.message}`
        });
    }
});

bot.onText(/\/addown (\d+)/, (msg, match) => {
    if (msg.from.id !== config.OWNER_ID) return; 
    const userId = parseInt(match[1]);
    let owners = get_owners();

    if (owners.includes(userId)) {
        return bot.sendMessage(msg.chat.id, `⚠️ User ${userId} is already registered as an Owner.`);
    }

    owners.push(userId);
    write_db('owners.json', owners);
    
    let user = get_user(userId);
    user.status = 'owner';
    save_user(user);

    bot.sendMessage(msg.chat.id, `✅ User ${userId} was successfully added as a **Secondary Owner**.`, { parse_mode: 'Markdown' });
    bot.sendMessage(userId, "👑 You have been appointed as an **Owner** of this bot!", { parse_mode: 'Markdown' });
});

bot.onText(/\/delown (\d+)/, (msg, match) => {
    if (msg.from.id !== config.OWNER_ID) return; 
    const userId = parseInt(match[1]);

    if (userId === config.OWNER_ID) {
        return bot.sendMessage(msg.chat.id, "❌ The primary Owner cannot be removed.");
    }
    
    let owners = get_owners();
    const initial_length = owners.length;
    owners = owners.filter(id => id !== userId);
    
    if (owners.length === initial_length) {
        return bot.sendMessage(msg.chat.id, `❌ User ${userId} is not an Owner.`);
    }

    write_db('owners.json', owners);
    
    let user = get_user(userId);
    user.status = 'free'; 
    save_user(user);

    bot.sendMessage(msg.chat.id, `✅ User ${userId} was successfully removed from the Owner list.`);
    bot.sendMessage(userId, "⚠️ Your Owner access has been revoked.", { parse_mode: 'Markdown' });
});

bot.onText(/\/addgroup/, async (msg) => {
    if (!is_owner(msg.from.id)) return;
    if (!msg.chat.type.includes('group')) {
        return bot.sendMessage(msg.chat.id, "❌ This command must be run inside a Group.");
    }
    
    const chatId = msg.chat.id;
    const chatTitle = msg.chat.title;
    
    if (!await is_bot_admin(chatId)) {
        return bot.sendMessage(chatId, "❌ The bot must be an **Administrator** in this group to be registered.", { reply_to_message_id: msg.message_id });
    }
    
    let groups = read_db('groups.json');
    if (groups[chatId]) {
        return bot.sendMessage(chatId, `⚠️ Group **${chatTitle}** is already registered. (Current cooldown: ${groups[chatId].cooldown/1000} seconds)`, { parse_mode: 'Markdown', reply_to_message_id: msg.message_id });
    }
    
    groups[chatId] = {
        title: chatTitle,
        cooldown: 60000, 
        last_fix: 0
    };
    write_db('groups.json', groups);
    
    bot.sendMessage(chatId, `✅ Group **${chatTitle}** was successfully registered! Default group cooldown: 1 minute.\n\nOwner can change it with \`/setgroupcd <minutes>\`.`, { parse_mode: 'Markdown', reply_to_message_id: msg.message_id });
});

bot.onText(/\/delgroup/, (msg) => {
    if (!is_owner(msg.from.id)) return;
    if (!msg.chat.type.includes('group')) {
        return bot.sendMessage(msg.chat.id, "❌ This command must be run inside a Group.");
    }
    
    const chatId = msg.chat.id;
    let groups = read_db('groups.json');
    
    if (!groups[chatId]) {
        return bot.sendMessage(chatId, "⚠️ This group is not registered.", { reply_to_message_id: msg.message_id });
    }
    
    const chatTitle = groups[chatId].title;
    delete groups[chatId];
    write_db('groups.json', groups);
    
    bot.sendMessage(chatId, `✅ Group **${chatTitle}** was successfully removed from the bot list.`, { parse_mode: 'Markdown', reply_to_message_id: msg.message_id });
});

bot.onText(/\/setgroupcd (\d+)/, (msg, match) => {
    if (!is_owner(msg.from.id)) return;
    if (!msg.chat.type.includes('group')) {
        return bot.sendMessage(msg.chat.id, "❌ This command must be run inside a Group.");
    }
    
    const chatId = msg.chat.id;
    const minutes = parseInt(match[1]);
    
    if (!is_group_registered(chatId)) {
        return bot.sendMessage(chatId, "❌ This group is not registered. Use `/addgroup` first.", { reply_to_message_id: msg.message_id });
    }
    if (isNaN(minutes) || minutes < 1) {
        return bot.sendMessage(chatId, "⚠️ Enter a valid number of minutes.");
    }
    
    const new_cooldown = minutes * 60 * 1000;
    update_group_cooldown(chatId, new_cooldown);
    bot.sendMessage(chatId, `✅ Group cooldown for **${msg.chat.title}** was successfully set to **${minutes} minutes** (${minutes * 60} seconds).`, { parse_mode: 'Markdown', reply_to_message_id: msg.message_id });
});

bot.onText(/\/listgroups/, (msg) => {
    if (!is_owner(msg.from.id)) return;
    const groups = read_db('groups.json');
    const groupList = Object.entries(groups).map(([id, data]) => 
        `**ID:** \`${id}\`\n**Name:** ${data.title}\n**CD:** ${data.cooldown/60000} minutes`
    ).join('\n\n');
    
    bot.sendMessage(msg.chat.id, `👥 **Registered Groups List (${Object.keys(groups).length})**\n\n${groupList || 'No registered groups.'}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/setcd (\d+)/, async (msg, match) => {
    if (!is_owner(msg.from.id)) return;
    const minutes = parseInt(match[1]);
    if (isNaN(minutes) || minutes < 1) {
        return bot.sendMessage(msg.chat.id, "⚠️ Enter a valid number of minutes.");
    }
    const new_cooldown = minutes * 60 * 1000;
    update_settings('cooldown_duration', new_cooldown);
    bot.sendMessage(msg.chat.id, `✅ **Individual user** cooldown was successfully set to **${minutes} minutes**.`);
});

bot.onText(/\/getlimitpoin (\d+)/, async (msg, match) => {
    if (msg.chat.id !== msg.from.id) { 
        return bot.sendMessage(msg.chat.id, "❌ This command can only be run in the bot's Private Chat.", { reply_to_message_id: msg.message_id });
    }
    
    const userId = msg.from.id;
    const poinToUse = parseInt(match[1]);
    let user = get_user(userId);
    
    if (isNaN(poinToUse) || poinToUse < 3) {
        return bot.sendMessage(msg.chat.id, "❌ The number of points to exchange must be at least **3 points**.");
    }
    
    if (user.referral_points < poinToUse) {
        return bot.sendMessage(msg.chat.id, `❌ Your points are insufficient. Your current points: **${user.referral_points}**.`);
    }
    
    const limitGained = Math.floor(poinToUse / 3);
    const pointsUsed = limitGained * 3;
    
    user.referral_points -= pointsUsed;
    user.fix_limit += limitGained;
    save_user(user);
    
    bot.sendMessage(msg.chat.id, `✅ Exchange successful! You exchanged **${pointsUsed} points** to receive **${limitGained} additional /fix limits**.\n\nYour current limit: **${user.fix_limit}x**\nRemaining points: **${user.referral_points}**`);
});

bot.onText(/\/addemail (.+)/, (msg, match) => { 
    if (!is_owner(msg.from.id)) return;
    const parts = match[1].split(' ');
    if (parts.length < 2) {
        return bot.sendMessage(msg.chat.id, "❌ Invalid format. Use: `/addemail <email> <app_password>`");
    }

    const email = parts[0];
    const app_pass = parts.slice(1).join(' ');
    
    let emails = read_db('emails.json');
    const newId = emails.length > 0 ? emails[emails.length - 1].id + 1 : 1;

    if (emails.find(e => e.email === email)) {
        return bot.sendMessage(msg.chat.id, `⚠️ Email ${email} is already registered.`);
    }

    emails.push({ id: newId, email: email, app_pass: app_pass });
    write_db('emails.json', emails);
    bot.sendMessage(msg.chat.id, `✅ Email ${email} was successfully registered with ID **${newId}**. Use \`/setactiveemail ${newId}\` to use it.`);
});

bot.onText(/\/listemails/, (msg) => { 
    if (!is_owner(msg.from.id)) return;
    const emails = read_db('emails.json');
    const active_id = active_email_id;
    
    let list = `📧 **Registered Emails List:**\n\n`;
    list += `**ID 0 (Default Config):** ${config.EMAIL_SENDER} ${active_id === 0 ? ' [ACTIVE]' : ''}\n---\n`;

    emails.forEach(e => {
        list += `**ID ${e.id}:** ${e.email} ${e.id === active_id ? ' [ACTIVE]' : ''}\n`;
    });

    bot.sendMessage(msg.chat.id, list, { parse_mode: 'Markdown' });
});

bot.onText(/\/setactiveemail (\d+)/, (msg, match) => { 
    if (!is_owner(msg.from.id)) return;
    const id = parseInt(match[1]);

    if (id === 0) {
        update_settings('active_email_id', 0);
        return bot.sendMessage(msg.chat.id, `✅ Active email was successfully set to **ID 0 (Default Config)**: ${config.EMAIL_SENDER}.`);
    }

    const emails = read_db('emails.json');
    const email = emails.find(e => e.id === id);

    if (!email) {
        return bot.sendMessage(msg.chat.id, `❌ ID ${id} was not found.`);
    }

    update_settings('active_email_id', id);
    bot.sendMessage(msg.chat.id, `✅ Active email was successfully set to **ID ${id}**: ${email.email}.`);
});

bot.onText(/\/addpremium (\d+)/, (msg, match) => { 
    if (!is_owner(msg.from.id)) return;
    const userId = parseInt(match[1]);
    let premiumUsers = get_premium_users();

    if (premiumUsers.includes(userId)) {
        return bot.sendMessage(msg.chat.id, `⚠️ User ${userId} is already Premium.`);
    }

    premiumUsers.push(userId);
    update_premium_users(premiumUsers);
    
    let user = get_user(userId);
    user.status = 'premium';
    save_user(user);

    bot.sendMessage(msg.chat.id, `✅ User ${userId} was successfully promoted to **Premium**.`);
    bot.sendMessage(userId, "👑 Your account status has been upgraded to **Premium**!", { parse_mode: 'Markdown' });
});

bot.onText(/\/delprem (\d+)/, (msg, match) => { 
    if (!is_owner(msg.from.id)) return;
    const userId = parseInt(match[1]);
    let premiumUsers = get_premium_users();
    const initial_length = premiumUsers.length;
    premiumUsers = premiumUsers.filter(id => id !== userId);
    
    if (premiumUsers.length === initial_length) {
        return bot.sendMessage(msg.chat.id, `❌ User ${userId} is not Premium.`);
    }

    update_premium_users(premiumUsers);
    
    let user = get_user(userId);
    user.status = is_owner(userId) ? 'owner' : 'free';
    save_user(user);

    bot.sendMessage(msg.chat.id, `✅ User ${userId} was removed from the Premium list.`);
    bot.sendMessage(userId, "⚠️ Your Premium status has been revoked.", { parse_mode: 'Markdown' });
});

bot.onText(/\/ban (\d+)/, (msg, match) => { 
    if (!is_owner(msg.from.id)) return;
    const userId = parseInt(match[1]);
    
    let user = get_user(userId);
    if (is_owner(userId)) {
        return bot.sendMessage(msg.chat.id, "❌ Cannot ban an Owner.");
    }

    user.is_banned = 1;
    save_user(user);
    
    bot.sendMessage(msg.chat.id, `✅ User ${userId} was successfully banned.`);
    bot.sendMessage(userId, "🚫 Your account has been blocked and cannot use this bot.", { parse_mode: 'Markdown' });
});

bot.onText(/\/unban (\d+)/, (msg, match) => { 
    if (!is_owner(msg.from.id)) return;
    const userId = parseInt(match[1]);
    
    let user = get_user(userId);
    user.is_banned = 0;
    save_user(user);
    
    bot.sendMessage(msg.chat.id, `✅ User ${userId} was successfully unbanned.`);
    bot.sendMessage(userId, "✅ Your account has been reactivated and can use this bot.", { parse_mode: 'Markdown' });
});

bot.onText(/\/owner_broadcast (.+)/, (msg, match) => { 
    if (!is_owner(msg.from.id)) return;
    const message = match[1];
    const users = get_all_users().filter(u => !u.is_banned); 
    let successCount = 0;
    
    users.forEach(user => {
        bot.sendMessage(user.id, `📢 **Message from Owner:**\n\n${message}`, { parse_mode: 'Markdown' })
           .then(() => successCount++)
           .catch(e => console.error(`Failed to send broadcast to ${user.id}: ${e.message}`));
    });

    setTimeout(() => {
        bot.sendMessage(msg.chat.id, `✅ Broadcast completed. Successfully sent to **${successCount}** users.`, { parse_mode: 'Markdown' });
    }, 5000); 
});

bot.onText(/\/setactivemt (\d+)/, (msg, match) => { 
    if (!is_owner(msg.from.id)) return;
    const id = parseInt(match[1]);
    const mt_text = get_mt_text_by_id(id);

    if (!mt_text) {
        return bot.sendMessage(msg.chat.id, `❌ MT ID ${id} was not found.`);
    }

    update_settings('active_mt_id', id);
    bot.sendMessage(msg.chat.id, `✅ Active Appeal Text was set to **ID ${id}** (Subject: ${mt_text.subject})`);
});

bot.onText(/\/offmt/, (msg) => { 
    if (!is_owner(msg.from.id)) return;
    update_settings('active_mt_id', 0);
    bot.sendMessage(msg.chat.id, `❌ Appeal Text was successfully **deactivated**.`);
});

bot.onText(/\/getuser (\d+)/, (msg, match) => { 
    if (!is_owner(msg.from.id)) return;
    const userId = parseInt(match[1]);
    const user = get_user(userId);
    
    const info = `
👤 **User Details ID ${userId}**
Username: @${user.username}
Status: **${user.status.toUpperCase()}**
Banned: ${user.is_banned ? 'YES' : 'NO'}
/fix Limit: **${user.fix_limit}x**
Referral Points: **${user.referral_points}**
Last /fix: ${user.last_fix ? new Date(user.last_fix).toLocaleString('id-ID') : 'Never'}
Referred By: ${user.referred_by || 'N/A'}
`;

    bot.sendMessage(msg.chat.id, info, { parse_mode: 'Markdown' });
});

bot.onText(/\/stats/, (msg) => { 
    if (!is_owner(msg.from.id)) return;
    const users = get_all_users();
    const totalUsers = users.length;
    const premiumCount = users.filter(u => u.status === 'premium').length;
    const ownerCount = users.filter(u => u.status === 'owner').length;
    const bannedCount = users.filter(u => u.is_banned).length;

    const stats = `
📊 **Bot Statistics**
Total Users: **${totalUsers}**
Owner (Total): **${ownerCount}**
Premium: **${premiumCount}**
Banned: **${bannedCount}**
`;
    bot.sendMessage(msg.chat.id, stats, { parse_mode: 'Markdown' });
});

bot.onText(/\/setmt (.+)/, (msg, match) => { 
    if (!is_owner(msg.from.id)) return;
    const parts = match[1].split('|').map(p => p.trim());

    if (parts.length < 3) {
        return bot.sendMessage(msg.chat.id, "❌ Invalid format. Use: `/setmt <destination_email> | <subject> | <message_body>`");
    }

    const [to_email, subject, body] = parts;

    if (!body.includes('{nomor}')) {
        return bot.sendMessage(msg.chat.id, "❌ The message body must contain `{nomor}` as the WhatsApp number placeholder.");
    }

    let mt_texts = get_mt_texts();
    const newId = mt_texts.length > 0 ? mt_texts[mt_texts.length - 1].id + 1 : 1;

    mt_texts.push({ id: newId, to_email, subject, body });
    write_db(config.MT_FILE, mt_texts);
    
    bot.sendMessage(msg.chat.id, `✅ MT ID **${newId}** was successfully added.\nSubject: ${subject}\nDestination Email: ${to_email}`);
});

bot.onText(/\/delmt (\d+)/, (msg, match) => { 
    if (!is_owner(msg.from.id)) return;
    const id = parseInt(match[1]);
    let mt_texts = get_mt_texts();
    const initial_length = mt_texts.length;
    const mt_to_delete = mt_texts.find(mt => mt.id === id);

    if (!mt_to_delete) {
        return bot.sendMessage(msg.chat.id, `❌ MT ID ${id} was not found.`);
    }

    if (id === active_mt_id) {
        update_settings('active_mt_id', 0);
        bot.sendMessage(msg.chat.id, `⚠️ The active MT ID ${id} has been deactivated.`);
    }

    mt_texts = mt_texts.filter(mt => mt.id !== id);
    write_db(config.MT_FILE, mt_texts);

    bot.sendMessage(msg.chat.id, `✅ MT ID **${id}** (${mt_to_delete.subject}) was successfully deleted.`);
});

bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data = callbackQuery.data;

    if (!is_owner(callbackQuery.from.id) && data.startsWith('owner_')) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: "❌ You are not the owner.", show_alert: true });
    }

    const editMenuCaption = async (text, markup) => {
        const params = {
            chat_id: chatId, 
            message_id: messageId, 
            parse_mode: 'Markdown', 
            reply_markup: markup
        };
        
        try {
            await bot.editMessageCaption(text, params);
        } catch (e) {
            if (e.message.includes('message caption is empty') || e.message.includes('there is no text in the message to edit')) {
                 try {
                     await bot.editMessageText(text, params);
                 } catch (e2) {
                     if (!e2.message.includes('message is not modified')) {
                         throw e2; 
                     }
                 }
            } else if (!e.message.includes('message is not modified')) {
                 throw e; 
            }
        }
    };

    try {
        switch (data) {
            case 'support':
    await editMenuCaption(
`💖 🤲 الْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ ❤️

╭━━━〔 👑 𝐕𝐈𝐏 𝐒𝐔𝐏𝐏𝐎𝐑𝐓 〕━━━╮

💠 𝐎𝐖𝐍𝐄𝐑 𝐈𝐍𝐅𝐎𝐑𝐌𝐀𝐓𝐈𝐎𝐍

👑 OWNER: MR SAQLAIN
📱 TELEGRAM: @Mr_Saqlain1

╰━━━━━━━━━━━━━━━━━━╯

💌 NEED HELP?
Contact the owner directly for support.

🔗 https://t.me/Mr_Saqlain1

✨ ALL PRAISES TO ALLAH 🤲
💎 VIP ACCESS • PREMIUM SUPPORT 💎`,
        {
            inline_keyboard: [
                [
                    {
                        text: "📩 CONTACT OWNER",
                        url: "https://t.me/Mr_Saqlain1?text=𝐇𝐄𝐋𝐋𝐎_𝐒𝐀𝐐𝐋𝐀𝐈𝐍_𝐊𝐈𝐍𝐆👑🇵🇰",
                        style: "primary"
                    }
                ],
                [
                    {
                        text: "↩️ Back",
                        callback_data: "start",
                        style: "success"
                    }
                ]
            ]
        }
    );
    break;
            case 'tutorial':
                await editMenuCaption("📝 **Email Appeal Tutorial**\n\nUse the `/fix <number>` feature (e.g., `/fix +923000xxxx`). Replies from WhatsApp will be automatically checked and sent to this chat.", 
                    { inline_keyboard: [[{ text: "↩️ Back", callback_data: "start", style: "primary" }]] });
                break;
            case 'fix_merah_menu':
                const user = get_user(callbackQuery.from.id);
                const cd_indv = cooldown_duration / 60000;
                await editMenuCaption(`⚙️ **Red Fix Feature**\n\nYour limit: **${user.fix_limit}x**\nIndividual Cooldown: **${cd_indv} minutes**.\n\nUse the \`/fix <number>\` command (e.g., \`/fix +923000xxxx\`) to send an automatic appeal.`, 
                    { inline_keyboard: [[{ text: "↩️ Back", callback_data: "start", style: "primary" }]] });
                break;
            case 'owner_menu':
                const current_active_mt = active_mt_id > 0 ? `ID **${active_mt_id}**` : '❌ INACTIVE';
                const owner_keyboard = {
                    inline_keyboard: [
                        [{ text: "Active Email Status", callback_data: "owner_email_status", style: "primary" }], 
                        [{ text: "Manage Emails (Multi)", callback_data: "owner_email_menu", style: "success" }],
                        [{ text: "Manage MT Text", callback_data: "owner_mt_menu", style: "primary" }],
                        [{ text: "Manage Groups & Group CD", callback_data: "owner_group_menu", style: "success" }],
                        [{ text: "Manage Owners", callback_data: "owner_owner_menu", style: "primary" }],
                        [{ text: "List All Users", callback_data: "owner_list_user", style: "success" }],
                        [{ text: "Fix History", callback_data: "owner_history_fix", style: "primary" }],
                        [{ text: "Broadcast All Users", callback_data: "owner_broadcast_menu", style: "success" }],
                        [{ text: "Manage Premium & Access", callback_data: "owner_access_menu", style: "primary" }],
                        [{ text: "Set Individual CD", callback_data: "owner_setcd_menu", style: "success" }],
                        [{ text: "↩️ Back", callback_data: "start", style: "primary" }]
                    ]
                };
                await editMenuCaption(`⚙️ **Owner Menu**\n\nCurrently Active MT: ${current_active_mt}`, owner_keyboard);
                break;

            case 'owner_email_status':
                const creds_status = get_active_email_creds();
                let active_id_text;
                if (active_email_id === 0) {
                    active_id_text = `ID 0 (Default Config)`;
                } else {
                    const emails = read_db('emails.json');
                    const active_email_obj = emails.find(e => e.id === active_email_id);
                    if (active_email_obj) {
                        active_id_text = `ID ${active_email_id}`;
                    } else {
                        update_settings('active_email_id', 0);
                        active_id_text = `ID 0 (Default Config). The old ID ${active_email_id} was not found and has been reset.`;
                    }
                }
                await editMenuCaption(`📧 **Active Email Status**\n\nActive Email: \`${creds_status.user}\`\nActive ID: **${active_id_text}**`, 
                    { inline_keyboard: [[{ text: "↩️ Back", callback_data: "owner_menu", style: "primary" }]] });
                break;

            case 'owner_group_menu':
                await editMenuCaption(`👥 **Manage Groups & Group Cooldown**\n\n\\* The bot will only respond to /fix in registered groups.\n\n**Group Commands:**\n- \`/addgroup\` (inside a group)\n- \`/delgroup\` (inside a group)\n- \`/setgroupcd <minutes>\` (inside a group)\n- \`/listgroups\``,
                    { inline_keyboard: [[{ text: "↩️ Back", callback_data: "owner_menu", style: "primary" }]] });
                break;

            case 'owner_owner_menu':
                const owners = get_owners();
                const ownerList = owners.map(id => is_owner(id) && id === config.OWNER_ID ? `👑 ID ${id} (Primary)` : `👤 ID ${id}`).join('\n');
                await editMenuCaption(`👑 **Manage Bot Owners**\n\nCurrent Owners:\n${ownerList}\n\n**Owner Commands:**\n- \`/addown <id_user>\`\n- \`/delown <id_user>\``,
                    { inline_keyboard: [[{ text: "↩️ Back", callback_data: "owner_menu", style: "primary" }]] });
                break;
                
            case 'owner_email_menu':
                const email_menu_keyboard = {
                    inline_keyboard: [
                        [{ text: "List/Set Active Email", callback_data: "owner_list_email_menu", style: "primary" }],
                        [{ text: "Add New Email", callback_data: "owner_add_email_menu", style: "success" }],
                        [{ text: "↩️ Back", callback_data: "owner_menu", style: "primary" }]
                    ]
                };
                await editMenuCaption("📧 **Manage Multi-Account Emails**", email_menu_keyboard);
                break;

            case 'owner_list_email_menu':
                const list_emails_command = `\`/listemails\``;
                const set_active_command = `\`/setactiveemail <id>\``;
                await editMenuCaption(`📧 **List/Set Active Email**\n\nView all registered emails: ${list_emails_command}\nSet active email: ${set_active_command}\n\n*ID 0 is the email from config.js.*`, 
                    { inline_keyboard: [[{ text: "↩️ Back", callback_data: "owner_email_menu", style: "primary" }]] });
                break;

            case 'owner_add_email_menu':
                const add_email_command = `\`/addemail <email> <app_password>\``;
                await editMenuCaption(`📧 **Add New Email**\n\nUse the format: ${add_email_command}\n\n*You must use a Gmail App Password. Make sure IMAP is enabled!*`, 
                    { inline_keyboard: [[{ text: "↩️ Back", callback_data: "owner_email_menu", style: "primary" }]] });
                break;

            case 'owner_list_user':
                const users = get_all_users();
                const userText = users.map(r => `**ID:** ${r.id}, **@${r.username}**, Status: ${r.status}, Limit: ${r.fix_limit}x, Points: ${r.referral_points}`).join('\n');
                await editMenuCaption(`👤 **List All Users**\n\n${userText}`, 
                    { inline_keyboard: [[{ text: "↩️ Back", callback_data: "owner_menu", style: "primary" }]] });
                break;
                
            case 'owner_history_fix':
                const history = read_db(config.HISTORY_DB).filter(r => r.command.startsWith('/fix')).slice(-20).reverse();
                const historyText = history.map(r => `[${r.timestamp.split('T')[0]}] **@${r.username}** used ${r.command}`).join('\n');
                await editMenuCaption(`📜 **Latest Fix History**\n\n${historyText || 'No history.'}`, 
                    { inline_keyboard: [[{ text: "↩️ Back", callback_data: "owner_menu", style: "primary" }]] });
                break;

            case 'owner_broadcast_menu':
                await editMenuCaption("📢 **Broadcast**\n\nUse the command: `/owner_broadcast <message>`", 
                    { inline_keyboard: [[{ text: "↩️ Back", callback_data: "owner_menu", style: "primary" }]] });
                break;

            case 'owner_mt_menu':
                const mt_keyboard = {
                    inline_keyboard: [
                        [{ text: "View MT", callback_data: "owner_view_mt", style: "primary" }],
                        [{ text: "Activate/Deactivate MT", callback_data: "owner_set_active_menu", style: "success" }],
                        [{ text: "Add MT", callback_data: "owner_add_mt_menu", style: "primary" }],
                        [{ text: "Delete MT", callback_data: "owner_del_mt_menu", style: "success" }],
                        [{ text: "↩️ Back", callback_data: "owner_menu", style: "primary" }]
                    ]
                };
                await editMenuCaption("📝 **Manage MT Text**", mt_keyboard);
                break;

            case 'owner_set_active_menu':
                const current_active_status = active_mt_id > 0 ? `MT ID **${active_mt_id}** (Active)` : `None (Inactive)`;
                await editMenuCaption(`▶️ **Activate/Deactivate Appeal Text**\n\nStatus: ${current_active_status}\n\n➡️ **ACTIVATE:** Use the command \`/setactivemt <id_mt>\`\n➡️ **DEACTIVATE:** Use the command \`/offmt\``, 
                    { inline_keyboard: [[{ text: "↩️ Back", callback_data: "owner_mt_menu", style: "primary" }]] });
                break;

            case 'owner_view_mt':
                const mt_texts_view = get_mt_texts();
                const viewText = mt_texts_view.map(mt => `**ID:** ${mt.id}\n**Subject:** ${mt.subject}\n**Destination Email:** ${mt.to_email}\n**Body Snippet:** ${mt.body.substring(0, 50).replace(/\n/g, ' ')}...`).join('\n\n');
                await editMenuCaption(`📝 **MT List**\n\n${viewText || 'No MT available.'}`, 
                    { inline_keyboard: [[{ text: "↩️ Back", callback_data: "owner_mt_menu", style: "primary" }]] });
                break;

            case 'owner_add_mt_menu':
                await editMenuCaption("📝 **Add Appeal Text**\n\nUse the format: `/setmt <destination_email> | <subject> | <message_body>`\n\n*You must include `{nomor}` in the message body!*", 
                    { inline_keyboard: [[{ text: "↩️ Back", callback_data: "owner_mt_menu", style: "primary" }]] });
                break;

            case 'owner_del_mt_menu':
                await editMenuCaption("📝 **Delete Appeal Text**\n\nUse the format: `/delmt <id_mt>`", 
                    { inline_keyboard: [[{ text: "↩️ Back", callback_data: "owner_mt_menu", style: "primary" }]] });
                break;

            case 'owner_access_menu':
                await editMenuCaption("👮 **Manage Access & Premium**\n\n**Access Commands:**\n- `/addpremium <id_user>`\n- `/delprem <id_user>`\n- `/ban <id_user>`\n- `/unban <id_user>`", 
                    { inline_keyboard: [[{ text: "↩️ Back", callback_data: "owner_menu", style: "primary" }]] });
                break;

            case 'owner_setcd_menu':
                const cd_current = cooldown_duration / 60000;
                await editMenuCaption(`⏳ **Set Individual Cooldown**\n\nCurrent individual cooldown: **${cd_current} minutes**.\n\nUse the command: \`/setcd <minutes>\``, 
                    { inline_keyboard: [[{ text: "↩️ Back", callback_data: "owner_menu", style: "primary" }]] });
                break;

            case 'start':
                handleStart(callbackQuery.message, chatId, messageId); 
                break;
        }
    } catch (e) {
        if (e.message.includes('message is not modified')) {
            return bot.answerCallbackQuery(callbackQuery.id);
        }
        console.error("Error in callback query:", e);
        
        return bot.answerCallbackQuery(callbackQuery.id, { text: `❌ Failed to load menu. Try again from /start. (${e.message.split(':').pop().trim()})`, show_alert: true });
    }
    await bot.answerCallbackQuery(callbackQuery.id);
});

console.log("🚀 Bot is running on Termux (JSON File Database)...");

setInterval(check_and_notify_users, 30000);
