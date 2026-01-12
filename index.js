const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MessageFlags,
  SlashCommandBuilder,
  REST,
  Routes,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActivityType
} = require("discord.js");
const mongoose = require("mongoose");
const fetch = require("node-fetch");

// ===============================
// CONFIG
// ===============================
const token = "";
const mongoUri = "";
const groqApiKey = "";
const prefix = ",";

// OWNER IDS
const owners = ["1438381425584771244", "1376998048802144286",];
const ownerId = owners[0]; // used by some commands
function isOwner(id) {
  return owners.includes(id);
}

const trustedUsers = new Set(); // stores user IDs with trusted access

// ===============================
// CHANGELOG DATA
// ===============================
const changelog = [
  {
    title: "Afk Update",
    version: "1.5.0",
    date: "2026-01-12",
    changes: ["Added root commands", "added ,afk command", "fixed chatbot memory", "added some fun commands",]
  },
  {
    title: "Timezone Update",
    version: "1.0.0",
    date: "2026-01-11",
    changes: ["Added 150+ timezones", "added ,time command", "added ,settz command"]
  }
];

// ===============================
// MONGODB SCHEMAS
// ===============================
const conversationSchema = new mongoose.Schema({
  userId: String,
  username: String,
  history: [{ role: String, content: String }],
  memories: [{ fact: String, timestamp: Date }],
  lastUpdated: { type: Date, default: Date.now }
});

const timezoneSchema = new mongoose.Schema({
  userId: String,
  timezone: String,
  lastUpdated: { type: Date, default: Date.now }
});

const afkSchema = new mongoose.Schema({
  userId: String,
  guildId: String,
  reason: String,
  timestamp: { type: Date, default: Date.now }
});
const timerSchema = new mongoose.Schema({
  userId: String,
  endTime: Number,
  channelId: String
});
const statsSchema = new mongoose.Schema({
  totalMessages: Number,
  botMessages: Number,
  commandsUsed: Number,
  uniqueUsers: [String],
  lastUpdated: { type: Date, default: Date.now }
});

const cookieSchema = new mongoose.Schema({
  userId: String,
  cookies: { type: Number, default: 0 }
});


const Cookie = mongoose.model('Cookie', cookieSchema);
const Stats = mongoose.model("Stats", statsSchema);
const Timer = mongoose.model("Timer", timerSchema);
const Conversation = mongoose.model("Conversation", conversationSchema);
const Timezone = mongoose.model("Timezone", timezoneSchema);
const AFK = mongoose.model("AFK", afkSchema);

// ===============================
// MONGODB CONNECTION
// ===============================
mongoose.connect(mongoUri, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log("✅ Connected to MongoDB");
}).catch(err => {
  console.error("❌ MongoDB connection error:", err);
});

// ===============================
// CLIENT
// ===============================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences, // ADD THIS LINE
  ],
  partials: [Partials.Channel]
});

// ===== Minimal in-memory stats (ADDED) =====
const botStats = {
  totalMessages: 0,
  botMessages: 0,
  commandsUsed: 0,
  uniqueUsers: new Set()
};

// Count messages that *this bot* sends (so botMessages is accurate)
client.on("messageCreate", msg => {
  if (!client.user) return;
  if (msg.author && msg.author.bot && msg.author.id === client.user.id) {
    botStats.botMessages++;
  }
});
// ===========================================

async function getAIReply(userId, username, userMessage) {
  try {
    let convo = await Conversation.findOne({ userId });
    if (!convo) {
      convo = new Conversation({
        userId,
        username,
        history: [],
        memories: []
      });
    }

    const memoryContext = convo.memories.length > 0
      ? `\n\nThings I remember about ${username}:\n${convo.memories.map(m => `- ${m.fact}`).join('\n')}`
      : '';

    convo.history.push({ role: 'user', content: userMessage });

    if (convo.history.length > 20) {
      convo.history = convo.history.slice(-20);
    }

    const cleanHistory = convo.history.map(m => ({
      role: m.role,
      content: m.content
    }));

    const mainRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          {
            role: 'system',
            content: `You are "Ninja", a friendly AI assistant with perfect memory. You remember everything users tell you forever.

YOUR PERSONALITY:
- Friendly, helpful, and casual
- Natural conversational tone
- Keep responses 2-3 sentences unless more detail is needed

IMPORTANT:
- NEVER say @everyone or @here
- Reference past memories naturally when relevant
- Always answer questions
- If a user asks a question you can go over the 3 sentence rule
- Acknowledge when users share personal info${memoryContext}`
          },
          ...cleanHistory
        ],
        max_tokens: 200,
        temperature: 0.7
      })
    });

    const mainData = await mainRes.json();

    if (mainData.error) {
      console.error("Groq API Error:", mainData.error);
      return "Sorry, I'm having technical difficulties right now. Please try again!";
    }

    let reply = mainData.choices?.[0]?.message?.content || "I couldn't understand that, sorry!";
    reply = reply.replace(/@(everyone|here)/gi, '@ $1');

    convo.history.push({ role: 'assistant', content: reply });

    const memoryRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          {
            role: 'system',
            content: `Extract any personal facts, preferences, or information about the user from this conversation. 

Rules:
- Only extract facts the USER states about THEMSELVES
- Format as a simple list, one fact per line
- If no new facts, respond with "NONE"
- never say @everyone or @here
User: "${userMessage}"
Assistant: "${reply}"`
          },
          { role: 'user', content: 'Extract any memorable facts from this exchange.' }
        ],
        max_tokens: 150,
        temperature: 0.3
      })
    });

    const memoryData = await memoryRes.json();
    const extractedFacts = memoryData.choices?.[0]?.message?.content?.trim();

    if (extractedFacts && extractedFacts !== 'NONE') {
      const facts = extractedFacts.split('\n').filter(f => f.trim().length > 0);

      for (const fact of facts) {
        const cleanFact = fact.replace(/^[-•*]\s*/, '').trim();
        if (cleanFact.length > 0 && cleanFact.length < 200) {
          const exists = convo.memories.some(m =>
            m.fact.toLowerCase().includes(cleanFact.toLowerCase()) ||
            cleanFact.toLowerCase().includes(m.fact.toLowerCase())
          );
          if (!exists) {
            convo.memories.push({ fact: cleanFact, timestamp: new Date() });
          }
        }
      }
    }

    if (convo.memories.length > 50) {
      convo.memories = convo.memories.slice(-50);
    }

    convo.username = username;
    convo.lastUpdated = new Date();
    await convo.save();

    return reply;

  } catch (err) {
    console.error("AI error:", err);
    return "Oops! My brain glitched. Try again? 🤖";
  }
}

// ===============================
// CATEGORY COMMANDS
// ===============================
const categories = {
  utility: {
    label: "Utility",
    description: "Server info, user info, and tools",
    commands: [",help", ",mc/membercount"]
  },
  Maps: {
    label: "Countries",
    description: "All about countries",
    commands: [",country", ",map",]
  },
  fun: {
    label: "Fun",
    description: "View fun commands",
    commands: [",cookie @user", ",cookielb",",kill @user",]
  },
  afk: {
    label: "AFK",
    description: "Set your AFK status",
    commands: [",afk [reason]"]
  },
  animals: {
    label: "Animals",
    description: "Fox, cat, dog, etc.",
    commands: [""]
  },
  lore: {
    label: "Lore",
    description: "Create and share server lore",
    commands: [""]
  },
  spotify: {
    label: "Spotify",
    description: "All about Spotify",
    commands: [",spotify [@user]", "/spotify [@user]"]
  },
  gamecards: {
    label: "GameCards",
    description: "Pokemon cards but more",
    commands: [""]
  },
  Time: {
    label: "Time",
    description: "Show users timezones",
    commands: [",settz", ",time"]
  },
  root: {
    label: "root",
    description: "Owner-only commands",
    commands: [",status", ",say", ",reply,",",trust",",dm"]
  },
  info: {
    label: "Info",
    description: "Bot info and stats",
    commands: [",ping", ",uptime", ",changelog", ",stats"]
  },
  misc: {
    label: "Misc",
    description: "Other useful commands",
    commands: [",timer", ",removetimer"]
  }
};

const categoryOrder = [
  "utility",
  "Countries",
  "fun",
  "afk",
  "animals",
  "lore",
  "spotify",
  "gamecards",
  "Time",
  "root",
  "info",
  "misc"
];

// ===============================
// HELPER FUNCTIONS
// ===============================
function formatDuration(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${d}d ${h}h ${m}m ${s}s`;
}

async function getMongoUptimeSeconds() {
  try {
    const admin = mongoose.connection.db.admin();
    const status = await admin.serverStatus();
    return Math.floor(status.uptime);
  } catch (err) {
    console.error("MongoDB uptime fetch failed:", err);
    return 0;
  }
}

// ====== ADDED: total members helper ======
function getTotalMembersCount() {
  // Sum the memberCount for every guild the bot is in.
  // This counts users per-guild (users in multiple guilds are counted multiple times).
  return client.guilds.cache.reduce((sum, g) => sum + (g.memberCount || 0), 0);
}

function formatTimeInTimezone(tz) {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
  return formatter.format(now);
}

// ===============================
// TIMEZONE DATA
// ===============================
const timezones = {
  "Etc/GMT+12": "🌐 GMT-12:00",
  "Etc/GMT+11": "🌐 GMT-11:00",
  "Pacific/Honolulu": "🇺🇸 Honolulu (GMT-10:00)",
  "Etc/GMT+10": "🌐 GMT-10:00",
  "Pacific/Marquesas": "🌐 GMT-09:30",
  "America/Anchorage": "🇺🇸 Anchorage (GMT-09:00)",
  "Etc/GMT+9": "🌐 GMT-09:00",
  "America/Los_Angeles": "🇺🇸 Los Angeles (GMT-08:00)",
  "America/Tijuana": "🇲🇽 Tijuana (GMT-08:00)",
  "Etc/GMT+8": "🌐 GMT-08:00",
  "America/Phoenix": "🇺🇸 Phoenix (GMT-07:00)",
  "America/Denver": "🇺🇸 Denver (GMT-07:00)",
  "America/Chihuahua": "🇲🇽 Chihuahua (GMT-07:00)",
  "Etc/GMT+7": "🌐 GMT-07:00",
  "America/Chicago": "🇺🇸 Chicago (GMT-06:00)",
  "America/Mexico_City": "🇲🇽 Mexico City (GMT-06:00)",
  "America/Guatemala": "🇬🇹 Guatemala (GMT-06:00)",
  "Etc/GMT+6": "🌐 GMT-06:00",
  "America/New_York": "🇺🇸 New York (GMT-05:00)",
  "America/Toronto": "🇨🇦 Toronto (GMT-05:00)",
  "America/Bogota": "🇨🇴 Bogotá (GMT-05:00)",
  "America/Lima": "🇵🇪 Lima (GMT-05:00)",
  "Etc/GMT+5": "���� GMT-05:00",
  "America/Caracas": "🇻🇪 Caracas (GMT-04:00)",
  "America/Halifax": "🇨🇦 Halifax (GMT-04:00)",
  "America/Santiago": "🇨🇱 Santiago (GMT-04:00)",
  "Etc/GMT+4": "🌐 GMT-04:00",
  "America/St_Johns": "🇨🇦 St. Johns (GMT-03:30)",
  "America/Sao_Paulo": "🇧🇷 São Paulo (GMT-03:00)",
  "America/Buenos_Aires": "🇦🇷 Buenos Aires (GMT-03:00)",
  "America/Godthab": "🇬🇱 Godthab (GMT-03:00)",
  "Etc/GMT+3": "🌐 GMT-03:00",
  "Etc/GMT+2": "🌐 GMT-02:00",
  "Atlantic/Azores": "🇵🇹 Azores (GMT-01:00)",
  "Atlantic/Cape_Verde": "🇨🇻 Cape Verde (GMT-01:00)",
  "Etc/GMT+1": "🌐 GMT-01:00",
  "Europe/London": "🇬🇧 London (GMT+00:00)",
  "Europe/Dublin": "🇮🇪 Dublin (GMT+00:00)",
  "Africa/Casablanca": "🇲🇦 Casablanca (GMT+00:00)",
  "Etc/GMT": "🌐 GMT+00:00",
  "Europe/Paris": "🇫🇷 Paris (GMT+01:00)",
  "Europe/Berlin": "🇩🇪 Berlin (GMT+01:00)",
  "Europe/Rome": "🇮🇹 Rome (GMT+01:00)",
  "Europe/Madrid": "🇪🇸 Madrid (GMT+01:00)",
  "Europe/Amsterdam": "🇳🇱 Amsterdam (GMT+01:00)",
  "Europe/Brussels": "🇧🇪 Brussels (GMT+01:00)",
  "Europe/Vienna": "🇦🇹 Vienna (GMT+01:00)",
  "Europe/Stockholm": "🇸🇪 Stockholm (GMT+01:00)",
  "Europe/Copenhagen": "🇩🇰 Copenhagen (GMT+01:00)",
  "Europe/Oslo": "🇳🇴 Oslo (GMT+01:00)",
  "Europe/Warsaw": "🇵🇱 Warsaw (GMT+01:00)",
  "Europe/Prague": "🇨🇿 Prague (GMT+01:00)",
  "Europe/Budapest": "🇭🇺 Budapest (GMT+01:00)",
  "Africa/Lagos": "🇳🇬 Lagos (GMT+01:00)",
  "Etc/GMT-1": "🌐 GMT+01:00",
  "Europe/Athens": "🇬🇷 Athens (GMT+02:00)",
  "Europe/Bucharest": "🇷🇴 Bucharest (GMT+02:00)",
  "Europe/Helsinki": "🇫🇮 Helsinki (GMT+02:00)",
  "Europe/Istanbul": "🇹🇷 Istanbul (GMT+02:00)",
  "Africa/Cairo": "🇪🇬 Cairo (GMT+02:00)",
  "Africa/Johannesburg": "🇿🇦 Johannesburg (GMT+02:00)",
  "Asia/Jerusalem": "🇮🇱 Jerusalem (GMT+02:00)",
  "Etc/GMT-2": "🌐 GMT+02:00",
  "Europe/Moscow": "🇷🇺 Moscow (GMT+03:00)",
  "Asia/Baghdad": "🇮🇶 Baghdad (GMT+03:00)",
  "Asia/Kuwait": "🇰🇼 Kuwait (GMT+03:00)",
  "Asia/Riyadh": "🇸🇦 Riyadh (GMT+03:00)",
  "Africa/Nairobi": "🇰🇪 Nairobi (GMT+03:00)",
  "Etc/GMT-3": "🌐 GMT+03:00",
  "Asia/Tehran": "🇮🇷 Tehran (GMT+03:30)",
  "Asia/Dubai": "🇦🇪 Dubai (GMT+04:00)",
  "Asia/Baku": "🇦🇿 Baku (GMT+04:00)",
  "Etc/GMT-4": "🌐 GMT+04:00",
  "Asia/Kabul": "🇦🇫 Kabul (GMT+04:30)",
  "Asia/Karachi": "🇵🇰 Karachi (GMT+05:00)",
  "Asia/Tashkent": "🇺🇿 Tashkent (GMT+05:00)",
  "Etc/GMT-5": "🌐 GMT+05:00",
  "Asia/Kolkata": "🇮🇳 India (GMT+05:30)",
  "Asia/Colombo": "🇱🇰 Colombo (GMT+05:30)",
  "Asia/Kathmandu": "🇳🇵 Kathmandu (GMT+05:45)",
  "Asia/Dhaka": "🇧🇩 Dhaka (GMT+06:00)",
  "Asia/Almaty": "🇰🇿 Almaty (GMT+06:00)",
  "Etc/GMT-6": "🌐 GMT+06:00",
  "Asia/Yangon": "🇲🇲 Yangon (GMT+06:30)",
  "Asia/Bangkok": "🇹🇭 Bangkok (GMT+07:00)",
  "Asia/Jakarta": "🇮🇩 Jakarta (GMT+07:00)",
  "Asia/Ho_Chi_Minh": "🇻🇳 Ho Chi Minh (GMT+07:00)",
  "Etc/GMT-7": "🌐 GMT+07:00",
  "Asia/Shanghai": "🇨🇳 Shanghai (GMT+08:00)",
  "Asia/Hong_Kong": "🇭🇰 Hong Kong (GMT+08:00)",
  "Asia/Singapore": "🇸🇬 Singapore (GMT+08:00)",
  "Asia/Taipei": "🇹🇼 Taipei (GMT+08:00)",
  "Australia/Perth": "🇦🇺 Perth (GMT+08:00)",
  "Asia/Manila": "🇵🇭 Manila (GMT+08:00)",
  "Etc/GMT-8": "🌐 GMT+08:00",
  "Asia/Tokyo": "🇯🇵 Tokyo (GMT+09:00)",
  "Asia/Seoul": "🇰🇷 Seoul (GMT+09:00)",
  "Etc/GMT-9": "🌐 GMT+09:00",
  "Australia/Adelaide": "🇦🇺 Adelaide (GMT+09:30)",
  "Australia/Darwin": "🇦🇺 Darwin (GMT+09:30)",
  "Australia/Sydney": "🇦🇺 Sydney (GMT+10:00)",
  "Australia/Melbourne": "🇦🇺 Melbourne (GMT+10:00)",
  "Australia/Brisbane": "🇦🇺 Brisbane (GMT+10:00)",
  "Pacific/Guam": "🇬🇺 Guam (GMT+10:00)",
  "Etc/GMT-10": "🌐 GMT+10:00",
  "Pacific/Noumea": "🇳🇨 Noumea (GMT+11:00)",
  "Etc/GMT-11": "🌐 GMT+11:00",
  "Pacific/Auckland": "🇳🇿 Auckland (GMT+12:00)",
  "Pacific/Fiji": "🇫🇯 Fiji (GMT+12:00)",
  "Etc/GMT-12": "🌐 GMT+12:00",
  "Pacific/Tongatapu": "🇹🇴 Tongatapu (GMT+13:00)",
  "Etc/GMT-13": "🌐 GMT+13:00",
  "Pacific/Kiritimati": "🇰🇮 Kiritimati (GMT+14:00)",
  "Etc/GMT-14": "🌐 GMT+14:00"
};

// ===============================
// CONTAINER BUILDERS
// ===============================
function buildChangelogContainer(page = 0) {
  const changelogEntry = changelog[page];
  const container = new ContainerBuilder();

  const title = new TextDisplayBuilder().setContent(`## ${changelogEntry.title}`);
  const subtitle = new TextDisplayBuilder().setContent(`Version ${changelogEntry.version} - ${changelogEntry.date}`);

  const changesList = changelogEntry.changes.map(change => `• ${change}`).join('\n');
  const body = new TextDisplayBuilder().setContent(changesList);

  const footer = new TextDisplayBuilder().setContent(`\nPage ${page + 1} of ${changelog.length}`);

  const separator = new SeparatorBuilder()
    .setSpacing(SeparatorSpacingSize.Small)
    .setDivider(true);

  container
    .addTextDisplayComponents(title)
    .addTextDisplayComponents(subtitle)
    .addSeparatorComponents(separator)
    .addTextDisplayComponents(body)
    .addTextDisplayComponents(footer);

  return container;
}

function buildChangelogButtons(page = 0) {
  const prevButton = new ButtonBuilder()
    .setCustomId(`changelog_prev:${page}`)
    .setLabel("Previous")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(page === 0);

  const nextButton = new ButtonBuilder()
    .setCustomId(`changelog_next:${page}`)
    .setLabel("Next")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(page === changelog.length - 1);

  const latestButton = new ButtonBuilder()
    .setCustomId("changelog_latest")
    .setLabel("Latest")
    .setStyle(ButtonStyle.Primary)
    .setDisabled(page === 0);

  return new ActionRowBuilder().addComponents(prevButton, nextButton, latestButton);
}

function buildHelpOverviewContainer() {
  const container = new ContainerBuilder();

  const title = new TextDisplayBuilder().setContent("## Help Menu");
  const descLines = [];

  descLines.push("Select a category below to begin.\n");

  const firstFourKeys = categoryOrder.slice(0, 4);
  for (const key of firstFourKeys) {
    const cat = categories[key];
    const count = cat.commands.filter(c => c && c.trim().length > 0).length;
    descLines.push(`**${cat.label} — ${count} command${count === 1 ? "" : "s"}**\n${cat.description}`);
  }

  descLines.push("\n*+8 more categories in dropdown*");

  const description = new TextDisplayBuilder().setContent(descLines.join("\n"));

  const separator = new SeparatorBuilder()
    .setSpacing(SeparatorSpacingSize.Small)
    .setDivider(true);

  container
    .addTextDisplayComponents(title)
    .addTextDisplayComponents(description)
    .addSeparatorComponents(separator);

  return container;
}

function buildHelpDropdown() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("help_dropdown")
    .setPlaceholder("Select a category")
    .addOptions(
      categoryOrder.map(key => {
        const cat = categories[key];
        const count = cat.commands.filter(c => c && c.trim().length > 0).length;
        return {
          label: cat.label,
          description: `${cat.description} (${count} cmd${count === 1 ? "" : "s"})`,
          value: key
        };
      })
    );

  return new ActionRowBuilder().addComponents(menu);
}

function buildHelpCategoryContainer(categoryKey) {
  const cat = categories[categoryKey];
  const container = new ContainerBuilder();

  const title = new TextDisplayBuilder().setContent(`## Category: ${cat.label}`);

  const count = cat.commands.filter(c => c && c.trim().length > 0).length;
  const lines = [];

  lines.push(`**${cat.label} — ${count} command${count === 1 ? "" : "s"}**`);
  lines.push(cat.description);

  if (count > 0) {
    lines.push("");
    for (const cmd of cat.commands) {
      if (!cmd || !cmd.trim().length) continue;
      lines.push(`• \`${cmd}\``);
    }
  }

  const description = new TextDisplayBuilder().setContent(lines.join("\n"));

  const separator = new SeparatorBuilder()
    .setSpacing(SeparatorSpacingSize.Small)
    .setDivider(true);

  container
    .addTextDisplayComponents(title)
    .addTextDisplayComponents(description)
    .addSeparatorComponents(separator);

  return container;
}

function buildStatusContainer() {
  const container = new ContainerBuilder();

  const title = new TextDisplayBuilder().setContent("## Owner Status Control");
  const body = new TextDisplayBuilder().setContent(
    "Select a status type from the menu below. A popup will appear for you to type the status text.\n\nOnly the bot owner can use this."
  );

  const separator = new SeparatorBuilder()
    .setSpacing(SeparatorSpacingSize.Small)
    .setDivider(true);

  container
    .addTextDisplayComponents(title)
    .addTextDisplayComponents(body)
    .addSeparatorComponents(separator);

  return container;
}

function buildStatusDropdown() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("status_type")
    .setPlaceholder("Select a status type")
    .addOptions(
      {
        label: "Playing",
        description: "Set a 'Playing' status",
        value: "PLAYING"
      },
      {
        label: "Listening",
        description: "Set a 'Listening to' status",
        value: "LISTENING"
      },
      {
        label: "Watching",
        description: "Set a 'Watching' status",
        value: "WATCHING"
      },
      {
        label: "Competing",
        description: "Set a 'Competing in' status",
        value: "COMPETING"
      }
    );

  return new ActionRowBuilder().addComponents(menu);
}

function buildPingContainer(latency, wsPing) {
  const container = new ContainerBuilder();

  const title = new TextDisplayBuilder().setContent("## 🏓 Pong!");

  const uptime = formatDuration(Math.floor(process.uptime()));

  const body = new TextDisplayBuilder().setContent(
    `**Latency:** \`${latency}ms\`\n**WebSocket:** \`${wsPing}ms\`\n**Uptime:** \`${uptime}\``
  );

  const separator = new SeparatorBuilder()
    .setSpacing(SeparatorSpacingSize.Small)
    .setDivider(true);

  container
    .addTextDisplayComponents(title)
    .addTextDisplayComponents(body)
    .addSeparatorComponents(separator);

  return container;
}
function buildSpotifyContainer(member) {
  const container = new ContainerBuilder();

  // Check if user has Spotify activity
  const spotify = member.presence?.activities?.find(
    activity => activity.name === "Spotify" && activity.type === 2
  );

  if (!spotify) {
    const title = new TextDisplayBuilder().setContent("## 🎵 No Spotify Activity");
    const body = new TextDisplayBuilder().setContent(
      `<@${member.id}> is not currently listening to Spotify.`
    );

    const separator = new SeparatorBuilder()
      .setSpacing(SeparatorSpacingSize.Small)
      .setDivider(true);

    container
      .addTextDisplayComponents(title)
      .addTextDisplayComponents(body)
      .addSeparatorComponents(separator);

    return container;
  }

  // Extract Spotify data
  const trackTitle = spotify.details || "Unknown Track";
  const artist = spotify.state || "Unknown Artist";
  const album = spotify.assets?.largeText || "Unknown Album";

  const albumArt = spotify.assets?.largeImage
    ? `https://i.scdn.co/image/${spotify.assets.largeImage.replace("spotify:", "")}`
    : null;

  const trackUrl = `https://open.spotify.com/track/${spotify.syncId}`;

  // Calculate progress
  const start = spotify.timestamps?.start;
  const end = spotify.timestamps?.end;
  let progress = "";

  if (start && end) {
    const elapsed = Date.now() - start;
    const total = end - start;
    const percentage = Math.floor((elapsed / total) * 100);

    const elapsedMin = Math.floor(elapsed / 60000);
    const elapsedSec = Math.floor((elapsed % 60000) / 1000);

    const totalMin = Math.floor(total / 60000);
    const totalSec = Math.floor((total % 60000) / 1000);

    progress =
      `\n**Progress:** ${elapsedMin}:${elapsedSec.toString().padStart(2, "0")} / ` +
      `${totalMin}:${totalSec.toString().padStart(2, "0")} (${percentage}%)`;
  }

  const title = new TextDisplayBuilder().setContent(
    `## 🎵 Spotify - ${member.user.username}`
  );

  const body = new TextDisplayBuilder().setContent(
    `**Track:** ${trackTitle}\n` +
    `**Artist:** ${artist}\n` +
    `**Album:** ${album}${progress}\n\n` +
    (albumArt ? `**Album Art:** ${albumArt}\n\n` : "") +
    `[Listen on Spotify](${trackUrl})`
  );

  const separator = new SeparatorBuilder()
    .setSpacing(SeparatorSpacingSize.Small)
    .setDivider(true);

  container
    .addTextDisplayComponents(title)
    .addTextDisplayComponents(body)
    .addSeparatorComponents(separator);

  return container;
}


// ====== ADDED: buildTimeContainer & UI helpers ======
async function buildTimeContainer(userId, targetUserId = null) {
  const container = new ContainerBuilder();

  const checkUserId = targetUserId || userId;
  let tzData = null;
  try {
    tzData = await Timezone.findOne({ userId: checkUserId });
  } catch (e) {
    tzData = null;
  }

  if (!tzData) {
    const title = new TextDisplayBuilder().setContent("## ⏰ Timezone");
    const body = new TextDisplayBuilder().setContent(
      targetUserId
        ? "This user hasn't set their timezone yet."
        : "You haven't set your timezone yet!\n\nUse `/settz` or `,settz` to set your timezone."
    );

    const separator = new SeparatorBuilder()
      .setSpacing(SeparatorSpacingSize.Small)
      .setDivider(true);

    container
      .addTextDisplayComponents(title)
      .addTextDisplayComponents(body)
      .addSeparatorComponents(separator);

    return { container, hasButtons: false };
  }

  const tzDisplay = timezones[tzData.timezone] || tzData.timezone;
  const currentTime = formatTimeInTimezone(tzData.timezone);
  const unixTime = Math.floor(Date.now() / 1000);

  const title = new TextDisplayBuilder().setContent("## ⏰ Current Time");
  const body = new TextDisplayBuilder().setContent(
    `**Timezone:** ${tzDisplay}\n**Time:** ${currentTime}\n**Discord Time:** <t:${unixTime}:F>`
  );

  const separator = new SeparatorBuilder()
    .setSpacing(SeparatorSpacingSize.Small)
    .setDivider(true);

  container
    .addTextDisplayComponents(title)
    .addTextDisplayComponents(body)
    .addSeparatorComponents(separator);

  return { container, hasButtons: !targetUserId };
}

function buildTimeButtons() {
  const changeButton = new ButtonBuilder()
    .setCustomId("time_change")
    .setLabel("Change Timezone")
    .setStyle(ButtonStyle.Primary);

  const unlinkButton = new ButtonBuilder()
    .setCustomId("time_unlink")
    .setLabel("Unlink")
    .setStyle(ButtonStyle.Danger);

  return new ActionRowBuilder().addComponents(changeButton, unlinkButton);
}

function buildTimezoneContainer(page = 0) {
  const container = new ContainerBuilder();

  const title = new TextDisplayBuilder().setContent("## ⏰ Set Your Timezone");
  const body = new TextDisplayBuilder().setContent(
    "Select your timezone from the dropdown below. Use the buttons to navigate between pages."
  );

  const separator = new SeparatorBuilder()
    .setSpacing(SeparatorSpacingSize.Small)
    .setDivider(true);

  container
    .addTextDisplayComponents(title)
    .addTextDisplayComponents(body)
    .addSeparatorComponents(separator);

  return container;
}

function buildTimezoneDropdown(page = 0) {
  const timezoneEntries = Object.entries(timezones);
  const itemsPerPage = 25;
  const totalPages = Math.ceil(timezoneEntries.length / itemsPerPage);

  const startIdx = page * itemsPerPage;
  const endIdx = Math.min(startIdx + itemsPerPage, timezoneEntries.length);
  const pageTimezones = timezoneEntries.slice(startIdx, endIdx);

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`timezone_select:${page}`)
    .setPlaceholder(`Select your timezone (Page ${page + 1}/${totalPages})`)
    .addOptions(
      pageTimezones.map(([tz, display]) => ({
        label: display.length > 100 ? display.substring(0, 97) + "..." : display,
        value: tz
      }))
    );

  return new ActionRowBuilder().addComponents(menu);
}

function buildTimezoneButtons(page = 0) {
  const totalPages = Math.ceil(Object.keys(timezones).length / 25);

  const prevButton = new ButtonBuilder()
    .setCustomId(`tz_prev:${page}`)
    .setLabel("Previous")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(page === 0);

  const nextButton = new ButtonBuilder()
    .setCustomId(`tz_next:${page}`)
    .setLabel("Next")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(page >= totalPages - 1);

  return new ActionRowBuilder().addComponents(prevButton, nextButton);
}
// =======================================================================

// ===============================
// REGISTER SLASH COMMANDS
// ===============================
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  client.user.setPresence({
    activities: [{ name: 'and remembering everything 🧠', type: ActivityType.Listening }],
    status: 'online'
  });

 const commands = [
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show the help menu")
    .setDMPermission(true)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Show bot latency")
    .setDMPermission(true)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("uptime")
    .setDescription("Show bot and database uptime")
    .setDMPermission(true)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("changelog")
    .setDescription("View bot changelog and updates")
    .setDMPermission(true)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("time")
    .setDescription("View your or another user's current time")
    .addUserOption(option =>
      option
        .setName("user")
        .setDescription("The user whose time to check")
        .setRequired(false)
    )
    .setDMPermission(true)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("settz")
    .setDescription("Set your timezone")
    .setDMPermission(true)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("afk")
    .setDescription("Set your AFK status")
    .addStringOption(option =>
      option
        .setName("reason")
        .setDescription("Why are you AFK?")
        .setRequired(false)
    )
    .setDMPermission(true)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("timer")
    .setDescription("Set a timer")
    .addStringOption(option =>
      option
        .setName("time")
        .setDescription("10s, 5m, 2h")
        .setRequired(true)
    )
    .setDMPermission(true)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("removetimer")
    .setDescription("Remove your active timer")
    .setDMPermission(true)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Show bot statistics")
    .setDMPermission(true)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("spotify")
    .setDescription("Check what someone is listening to on Spotify")
    .setDMPermission(true)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("cookie")
    .setDescription("Give someone a cookie.")
    .setDMPermission(true)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("kill")
    .setDescription("Dramatically eliminate someone in a goofy, chaotic way.")
    .setDMPermission(true)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("cookielb")
    .setDescription("View the global cookie leaderboard.")
    .setDMPermission(true)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("membercount")
    .setDescription("Shows the server's member count")
    .setDMPermission(true)
    .toJSON(),

  new SlashCommandBuilder()
    .setName("country")
    .setDescription("Shows information about a country")
    .addStringOption(opt =>
      opt.setName("name")
        .setDescription("Country name")
        .setRequired(true)
    )
    .setDMPermission(true)
    .toJSON(),

new SlashCommandBuilder()
  .setName("map")
  .setDescription("Sends a map image of a country")
  .addStringOption(opt =>
    opt.setName("country")
      .setDescription("Country name")
      .setRequired(true)
  )
  .setDMPermission(true)
  .toJSON(),


  ];


  const rest = new REST({ version: "10" }).setToken(token);

  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log("✅ Slash commands registered");
  } catch (err) {
    console.error("❌ Failed to register slash commands:", err);
  }
});

// ===============================
// MESSAGE HANDLER
// ===============================
client.on("messageCreate", async message => {
  if (message.author.bot) return;

  // -------------------------
  // STATS TRACKING
  // -------------------------
  botStats.totalMessages++;
  botStats.uniqueUsers.add(message.author.id);

  if (message.content.startsWith(prefix)) {
    botStats.commandsUsed++;
  }
  // -------------------------

  // CHECK IF USER IS RETURNING FROM AFK
  const userAfk = await AFK.findOne({ userId: message.author.id, guildId: message.guild?.id });
  if (userAfk) {
    await AFK.deleteOne({ userId: message.author.id, guildId: message.guild?.id });
    const duration = Date.now() - userAfk.timestamp.getTime();
    const durationStr = formatDuration(Math.floor(duration / 1000));

    const container = new ContainerBuilder();
    const title = new TextDisplayBuilder().setContent("## 👋 Welcome Back!");
    const body = new TextDisplayBuilder().setContent(
      `<@${message.author.id}>, you were AFK for **${durationStr}**.`
    );

    const separator = new SeparatorBuilder()
      .setSpacing(SeparatorSpacingSize.Small)
      .setDivider(true);

    container
      .addTextDisplayComponents(title)
      .addTextDisplayComponents(body)
      .addSeparatorComponents(separator);

    await message.reply({
      components: [container],
      flags: MessageFlags.IsPersistent | MessageFlags.IsComponentsV2,
      allowedMentions: { repliedUser: false }
    });
  }

  // CHECK IF MENTIONED USER IS AFK
  if (message.mentions.users.size > 0) {
    for (const [userId, user] of message.mentions.users) {
      if (user.bot) continue;
      const mentionedAfk = await AFK.findOne({ userId, guildId: message.guild?.id });
      if (mentionedAfk) {
        const duration = Date.now() - mentionedAfk.timestamp.getTime();
        const durationStr = formatDuration(Math.floor(duration / 1000));

        const container = new ContainerBuilder();
        const title = new TextDisplayBuilder().setContent("## 💤 User is AFK");
        const reason = mentionedAfk.reason ? `\n**Reason:** ${mentionedAfk.reason}` : '';
        const body = new TextDisplayBuilder().setContent(
          `<@${userId}> is currently AFK.${reason}\n**Since:** ${durationStr} ago`
        );

        const separator = new SeparatorBuilder()
          .setSpacing(SeparatorSpacingSize.Small)
          .setDivider(true);

        container
          .addTextDisplayComponents(title)
          .addTextDisplayComponents(body)
          .addSeparatorComponents(separator);

        await message.reply({
          components: [container],
          flags: MessageFlags.IsPersistent | MessageFlags.IsComponentsV2,
          allowedMentions: { repliedUser: false, parse: [] }
        });
        break;
      }
    }
  }

  const isMentioned = message.mentions.has(client.user.id);
  const isReply = message.reference && message.reference.messageId;

  let isReplyToBot = false;
  if (isReply) {
    const repliedMsg = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
    if (repliedMsg && repliedMsg.author.id === client.user.id) {
      isReplyToBot = true;
    }
  }

  if (isMentioned || isReplyToBot) {
    const userMessage = message.content.replace(/<@!?\d+>/g, '').trim();

    if (!userMessage) {
      return message.reply({ content: "Yes? How can I help you? 😊", allowedMentions: { repliedUser: false } });
    }

    await message.channel.sendTyping();

    const reply = await getAIReply(message.author.id, message.author.username, userMessage);
    return message.reply({ content: reply, allowedMentions: { repliedUser: false, parse: [] } });
  }

  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // --------- PREFIX COMMANDS (all kept inside messageCreate) ----------
  if (command === "help") {
    const container = buildHelpOverviewContainer();
    const dropdown = buildHelpDropdown();

    return message.reply({
      components: [container, dropdown],
      flags: MessageFlags.IsPersistent | MessageFlags.IsComponentsV2
    });
  }

  if (command === "changelog") {
    const container = buildChangelogContainer(0);
    const buttons = buildChangelogButtons(0);

    return message.reply({
      components: [container, buttons],
      flags: MessageFlags.IsPersistent | MessageFlags.IsComponentsV2
    });
  }

if (command === "kill") {
  const target = message.mentions.users.first();

  if (!target) {
    return message.reply({
      content: "You need to mention someone to eliminate them dramatically.",
      flags: MessageFlags.IsEphemeral
    });
  }

  if (target.id === message.author.id) {
    return message.reply({
      content: "You cannot eliminate yourself, dramatic one.",
      flags: MessageFlags.IsEphemeral
    });
  }

  const goofy = [
    `${message.author} bonked ${target} so hard they turned into confetti.`,
    `${target} slipped on a banana peel and vanished into the void.`,
    `${message.author} dropped a cartoon anvil on ${target}. *Toon physics intensifies.*`
  ];

  const rpg = [
    `${message.author} lands a **critical hit**! ${target} has fainted.`,
    `${target} failed their saving throw and was dramatically defeated.`,
    `${message.author} casts *Eliminate*. It's super effective.`
  ];

  const meme = [
    `${target} has been yeeted into the shadow realm.`,
    `${message.author} banned ${target} from existence.`,
    `${target} has been Thanos‑snapped out of the timeline.`
  ];

  const chaotic = [
    `A wormhole opened and swallowed ${target}. ${message.author} just shrugged.`,
    `${target} was erased by unknown cosmic forces. ${message.author} may or may not be responsible.`,
    `Reality glitched and ${target} despawned. Patch notes coming soon.`
  ];

  const all = [...goofy, ...rpg, ...meme, ...chaotic];
  const result = all[Math.floor(Math.random() * all.length)];

  const container = new ContainerBuilder()
    .setAccentColor(0xFF5555)
    .addTextDisplayComponents(t =>
      t.setContent(`## 💀 Dramatic Elimination\n${result}`)
    )
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small)
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`finishkill_${message.author.id}_${target.id}`)
      .setLabel("Finish Kill")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`revive_${message.author.id}_${target.id}`)
      .setLabel("Revive")
      .setStyle(ButtonStyle.Success)
  );

  return message.reply({
    components: [container, row],
    flags: MessageFlags.IsComponentsV2
  });
}

if (command === "membercount" || command === "mc") {
  const guild = message.guild;

  if (!guild) {
    return message.reply({
      content: "This command can only be used in a server.",
      flags: MessageFlags.IsEphemeral
    });
  }

  const name = guild.name;
  const count = guild.memberCount;

  const container = new ContainerBuilder()
    .setAccentColor(0x2b2d31)
    .addTextDisplayComponents(t =>
      t.setContent(`## 👥 Member Count\n**Server:** ${name}\n**Members:** ${count}`)
    );

  return message.reply({
    components: [container],
    flags: MessageFlags.IsComponentsV2
  });
}
if (command === "country" || command === "ci") {
  const name = args.join(" ");
  if (!name) {
    return message.reply("Please provide a country name.");
  }

  const query = encodeURIComponent(name);

  try {
    const res = await fetch(`https://restcountries.com/v3.1/name/${query}`);


    const data = await res.json();

    if (!Array.isArray(data) || !data[0]) {
      return message.reply("Country not found.");
    }

    const c = data[0];

    const countryName = c.name?.common || "Unknown";
    const capital = c.capital?.[0] || "None";
    const region = c.region || "Unknown";
    const population = c.population?.toLocaleString() || "Unknown";
    const currency = c.currencies ? Object.keys(c.currencies)[0] : "Unknown";
    const languages = c.languages ? Object.values(c.languages).join(", ") : "Unknown";
    const flag = c.flags?.png || c.flags?.svg || null;

    const container = new ContainerBuilder()
      .setAccentColor(0x2b2d31)
      .addTextDisplayComponents(t =>
        t.setContent(
          `## 🌍 Country Info: ${countryName}\n` +
          `**Capital:** ${capital}\n` +
          `**Region:** ${region}\n` +
          `**Population:** ${population}\n` +
          `**Currency:** ${currency}\n` +
          `**Languages:** ${languages}\n` +
          (flag ? `**Flag:** ${flag}` : "")
        )
      );

    return message.reply({
      components: [container],
      flags: MessageFlags.IsComponentsV2
    });

  } catch (err) {
    console.error(err);
    return message.reply("Error fetching country data.");
  }
}

if (command === "dm") {
  // OWNER CHECK
  if (message.author.id !== ownerId) {
    return message.reply("Only the bot owner can use this command.");
  }

  const target = message.mentions.users.first();
  if (!target) {
    return message.reply("You must mention a user to DM.");
  }

  const content = args.slice(1).join(" ");
  if (!content) {
    return message.reply("You must provide a message to send.");
  }

  try {
    await target.send(content);

    return message.reply(`Message sent to **${target.tag}**.`);
  } catch (err) {
    console.error("DM error:", err);
    return message.reply("I couldn't DM that user. They may have DMs disabled.");
  }
}
// inside your messageCreate handler





if (command === "map") {
  const name = args.join(" ");
  if (!name) return message.reply("Provide a country name.");

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(name)}`
    );
    const data = await res.json();

    if (!Array.isArray(data) || !data[0]) {
      return message.reply("Country not found.");
    }

    const { lat, lon, display_name } = data[0];

    const mapUrl = `https://static-maps.yandex.ru/1.x/?lang=en_US&ll=${lon},${lat}&z=4&size=650,450&l=map`;

    return message.reply({
      content: `🗺️ Map of ${display_name}`,
      files: [{ attachment: mapUrl, name: "map.png" }]
    });

  } catch (err) {
    console.error(err);
    return message.reply("Failed to fetch the map image.");
  }
}








  if (command === "spotify") {
  let targetMember = message.member;
  
  if (message.mentions.members.first()) {
    targetMember = message.mentions.members.first();
  } else if (args[0]) {
    targetMember = message.guild.members.cache.get(args[0]);
    if (!targetMember) {
      return message.reply("User not found.");
    }
  }
  
  const container = buildSpotifyContainer(targetMember);
  
  return message.reply({
    components: [container],
    flags: MessageFlags.IsPersistent | MessageFlags.IsComponentsV2
  });
}


 

if (command === 'cookie') {
  const target = message.mentions.users.first();

  if (!target) {
    return message.reply({
      content: 'You must mention someone to give a cookie.',
      flags: MessageFlags.IsEphemeral
    });
  }

  if (target.id === message.author.id) {
    return message.reply({
      content: 'You cannot give yourself a cookie.',
      flags: MessageFlags.IsEphemeral
    });
  }

  let entry = await Cookie.findOne({ userId: target.id });
  if (!entry) entry = await Cookie.create({ userId: target.id, cookies: 0 });

  entry.cookies += 1;
  await entry.save();

  const container = new ContainerBuilder()
    .setAccentColor(0xF4A261)
    .addTextDisplayComponents(t =>
      t.setContent(`## 🍪 Cookie Given!\n<@${message.author.id}> gave a cookie to <@${target.id}>!`)
    )
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setSpacing(SeparatorSpacingSize.Small)
        .setDivider(true)
    )
    .addTextDisplayComponents(t =>
      t.setContent(`**${target.username}** now has **${entry.cookies} cookies!**`)
    );

  return message.reply({
    components: [container],
    flags: MessageFlags.IsComponentsV2
  });
}

if (command === 'cookie' && args[0] === 'lb') {
  const top = await Cookie.find().sort({ cookies: -1 }).limit(10);

  if (!top.length) {
    const empty = new ContainerBuilder()
      .setAccentColor(0xF4A261)
      .addTextDisplayComponents(t =>
        t.setContent('## 🍪 Cookie Leaderboard\nNo cookies have been given yet.')
      );

    return message.reply({
      components: [empty],
      flags: MessageFlags.IsComponentsV2
    });
  }

  let text = '## 🍪 Cookie Leaderboard\n';
  let rank = 1;

  for (const entry of top) {
    const user = await client.users.fetch(entry.userId).catch(() => null);
    const name = user ? user.username : `Unknown User (${entry.userId})`;

    text += `**${rank}.** ${name} — **${entry.cookies} cookies**\n`;
    rank++;
  }

  const container = new ContainerBuilder()
    .setAccentColor(0xF4A261)
    .addTextDisplayComponents(t => t.setContent(text));

  return message.reply({
    components: [container],
    flags: MessageFlags.IsComponentsV2
  });
}
if (command === 'cookielb') {
  const top = await Cookie.find().sort({ cookies: -1 }).limit(10);

  if (!top.length) {
    const empty = new ContainerBuilder()
      .setAccentColor(0xF4A261)
      .addTextDisplayComponents(t =>
        t.setContent('## 🍪 Cookie Leaderboard\nNo cookies have been given yet.')
      );

    return message.reply({
      components: [empty],
      flags: MessageFlags.IsComponentsV2
    });
  }

  let text = '## 🍪 Cookie Leaderboard\n';
  let rank = 1;

  for (const entry of top) {
    const user = await client.users.fetch(entry.userId).catch(() => null);
    const name = user ? user.username : `Unknown User (${entry.userId})`;

    text += `**${rank}.** ${name} — **${entry.cookies} cookies**\n`;
    rank++;
  }

  const container = new ContainerBuilder()
    .setAccentColor(0xF4A261)
    .addTextDisplayComponents(t => t.setContent(text));

  return message.reply({
    components: [container],
    flags: MessageFlags.IsComponentsV2
  });
}

if (command === 'cookie' && args[0] === 'lb') {
  const top = await Cookie.find().sort({ cookies: -1 }).limit(10);

  if (!top.length) {
    const empty = new ContainerBuilder()
      .setAccentColor(0xF4A261)
      .addTextDisplayComponents(t =>
        t.setContent('## 🍪 Cookie Leaderboard\nNo cookies have been given yet.')
      );

    return message.reply({
      components: [empty],
      flags: MessageFlags.IsComponentsV2
    });
  }

  let text = '## 🍪 Cookie Leaderboard\n';
  let rank = 1;

  for (const entry of top) {
    const user = await client.users.fetch(entry.userId).catch(() => null);
    const name = user ? user.username : `Unknown User (${entry.userId})`;

    text += `**${rank}.** ${name} — **${entry.cookies} cookies**\n`;
    rank++;
  }

  const container = new ContainerBuilder()
    .setAccentColor(0xF4A261)
    .addTextDisplayComponents(t => t.setContent(text));

  return message.reply({
    components: [container],
    flags: MessageFlags.IsComponentsV2
  });
}

if (command === "trust") {
  if (message.author.id !== ownerId) return;

  const target = message.mentions.users.first() || client.users.cache.get(args[0]);
  if (!target) return message.reply("Mention a user or provide their ID.");

  if (trustedUsers.has(target.id)) {
    return message.reply(`${target.tag} is already trusted.`);
  }

  const container = new ContainerBuilder()
    .setAccentColor(0x2b2d31)
    .addTextDisplayComponents(t =>
      t.setContent(
        `⚠️ **CRITICAL SECURITY WARNING**\n\n` +
        `You are about to grant **TRUSTED ACCESS** to <@${target.id}>.\n\n` +
        `Trusted users can:\n` +
        `• Execute **Owner-Only** commands\n` +
        `• Access sensitive bot internals\n` +
        `• Bypass standard restrictions\n\n` +
        `Only proceed if you absolutely trust this user.`
      )
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("Trust This User")
      .setCustomId(`trust-confirm-${target.id}`)
      .setStyle(ButtonStyle.Secondary)
  );

  return message.reply({
    components: [container, row],
    flags: MessageFlags.IsComponentsV2
  });
}
const content = message.content?.trim();


if (content === ',ping') {
  const now = Date.now();
  const latency = now - message.createdTimestamp;
  const wsPing = client.ws.ping;

  const container = new ContainerBuilder()
    .setAccentColor(0x2b2d31)
    .addTextDisplayComponents(t =>
      t.setContent(
        `## 🏓 Ping\n` +
        `**Latency:** ${latency}ms\n` +
        `**WebSocket:** ${wsPing}ms`
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setSpacing(SeparatorSpacingSize.Small)
        .setDivider(true)
    );

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ping_refresh_msg')
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Primary)
  );

  return message.reply({
    components: [container, buttons],
    flags: MessageFlags.IsComponentsV2
  });
}



if (command === "untrust") {
  if (message.author.id !== ownerId) return;

  const target = message.mentions.users.first() ||
                 client.users.cache.get(args[0]);

  if (!target) return message.reply("Mention a user or provide their ID.");

  if (!trustedUsers.has(target.id)) {
    return message.reply(`${target.tag} is not trusted.`);
  }

  trustedUsers.delete(target.id);
  return message.reply(`🚫 <@${target.id}> has been untrusted.`);
}

  // SAY COMMAND
  if (command === "say") {
    if (message.author.id !== ownerId) {
      return message.reply("You are not the owner.");
    }

    // Extract channel mention
    const channelMention = args[0];
    let targetChannel = message.channel;

    if (channelMention?.startsWith("<#") && channelMention.endsWith(">")) {
      const channelId = channelMention.replace(/[<#>]/g, "");
      targetChannel = message.guild.channels.cache.get(channelId);
      args.shift(); // remove channel from args
    }

    const text = args.join(" ");
    if (!text) return message.reply("You must provide a message.");

    if (!targetChannel) {
      return message.reply("Invalid channel.");
    }

    await targetChannel.send(text);
    return message.reply("Message sent.");
  }

  if (command === "timer") {
    const timeArg = args[0];
    if (!timeArg) return message.reply("Usage: ,timer <10s|5m|2h>");

    const match = timeArg.match(/(\d+)(s|m|h)/);
    if (!match) return message.reply("Invalid time format.");

    const amount = parseInt(match[1]);
    const unit = match[2];

    let ms = unit === "s" ? amount * 1000 :
      unit === "m" ? amount * 60000 :
        amount * 3600000;

    const existing = await Timer.findOne({ userId: message.author.id });
    if (existing) return message.reply("You already have a timer. Use ,removetimer.");

    const endTime = Date.now() + ms;

    await Timer.create({
      userId: message.author.id,
      endTime,
      channelId: message.channel.id
    });

    const container = new ContainerBuilder()
      .setAccentColor(0x2b2d31)
      .addTextDisplayComponents(t =>
        t.setContent(`⏳ Timer set for **${amount}${unit}**.`)
      );

    message.reply({
      components: [container],
      flags: MessageFlags.IsComponentsV2
    });

    setTimeout(async () => {
      const channel = message.channel;
      channel.send(`<@${message.author.id}> Your **${amount}${unit}** timer is up!`);
      await Timer.deleteOne({ userId: message.author.id });
    }, ms);
  }

  if (command === "removetimer") {
    const existing = await Timer.findOne({ userId: message.author.id });

    if (!existing) return message.reply("You have no active timer.");

    await Timer.deleteOne({ userId: message.author.id });

    const container = new ContainerBuilder()
      .setAccentColor(0xff4444)
      .addTextDisplayComponents(t =>
        t.setContent("���� Your timer has been cancelled.")
      );

    return message.reply({
      components: [container],
      flags: MessageFlags.IsComponentsV2
    });
  }

  if (command === "reply") {
    if (message.author.id !== ownerId) {
      return message.reply("You are not the owner.");
    }

    // Must have: userID, #channel, message
    if (args.length < 3) {
      return message.reply("Usage: ,reply <userID> <#channel> <message>");
    }

    const userId = args.shift();
    const channelMention = args.shift();

    // Validate channel mention
    if (!channelMention.startsWith("<#") || !channelMention.endsWith(">")) {
      return message.reply("Invalid channel. Mention a channel like #general.");
    }

    const channelId = channelMention.replace(/[<#>]/g, "");

    // Find the channel across ALL servers the bot is in
    const targetChannel = message.client.channels.cache.get(channelId);

    if (!targetChannel) {
      return message.reply("Channel not found in any server I'm in.");
    }

    // Fetch user
    let targetUser;
    try {
      targetUser = await message.client.users.fetch(userId);
    } catch {
      return message.reply("Invalid user ID.");
    }

    const text = args.join(" ");
    if (!text) {
      return message.reply("You must provide a message.");
    }

    // Send the reply
    await targetChannel.send({
      content: `<@${userId}> ${text}`
    });

    return message.reply("Reply sent.");
  }

  // Moderation commands (kick, mute, purge, ban, unban, unmute) - kept as in your code
  if (command === "kick") {
    const target = message.mentions.members.first() ||
      message.guild.members.cache.get(args[0]);

    if (!target) return message.reply("Please mention a user or provide their ID.");

    if (target.id === message.author.id) return message.reply("You can't kick yourself.");
    if (target.id === client.user.id) return message.reply("I can't kick myself.");

    const isOwnerById = message.author.id === ownerId;

    if (!isOwnerById && !message.member.permissions.has("KickMembers")) {
      return message.reply("You need the **Kick Members** permission to use this command.");
    }

    if (!message.guild.members.me.permissions.has("KickMembers")) {
      return message.reply("I don't have permission to kick members.");
    }

    if (!isOwnerById && target.roles.highest.position >= message.member.roles.highest.position) {
      return message.reply("You can't kick someone with an equal or higher role.");
    }

    const reason = args.slice(1).join(" ") || "No reason provided";

    try {
      await target.kick(reason);
      return message.reply(`👢 **${target.user.tag}** has been kicked.\n**Reason:** ${reason}`);
    } catch (err) {
      console.error(err);
      return message.reply("I couldn't kick that user. Check my permissions and role position.");
    }
  }

  if (command === "mute") {
    const target = message.mentions.members.first() ||
      message.guild.members.cache.get(args[0]);

    if (!target) return message.reply("Please mention a user or provide their ID.");

    if (target.id === message.author.id) return message.reply("You can't mute yourself.");
    if (target.id === client.user.id) return message.reply("I can't mute myself.");

    const isOwnerById = message.author.id === ownerId;

    if (!isOwnerById && !message.member.permissions.has("ModerateMembers")) {
      return message.reply("You need the **Moderate Members** permission to mute users.");
    }

    if (!message.guild.members.me.permissions.has("ModerateMembers")) {
      return message.reply("I don't have permission to mute members.");
    }

    if (!isOwnerById && target.roles.highest.position >= message.member.roles.highest.position) {
      return message.reply("You can't mute someone with an equal or higher role.");
    }

    const timeArg = args[1];
    if (!timeArg) return message.reply("Specify a duration (e.g., 10m, 1h).");

    const match = timeArg.match(/(\d+)(s|m|h|d)/);
    if (!match) return message.reply("Invalid time format. Use s, m, h, or d.");

    const amount = parseInt(match[1]);
    const unit = match[2];

    let ms =
      unit === "s" ? amount * 1000 :
        unit === "m" ? amount * 60000 :
          unit === "h" ? amount * 3600000 :
            amount * 86400000;

    const reason = args.slice(2).join(" ") || "No reason provided";

    try {
      await target.timeout(ms, reason);
      return message.reply(`🔇 **${target.user.tag}** has been muted for **${amount}${unit}**.\n**Reason:** ${reason}`);
    } catch (err) {
      console.error(err);
      return message.reply("I couldn't mute that user. Check my permissions and role position.");
    }
  }

  if (command === "purge") {
    const isOwnerById = message.author.id === ownerId;

    if (!isOwnerById && !message.member.permissions.has("ManageMessages")) {
      return message.reply("You need the **Manage Messages** permission to purge messages.");
    }

    if (!message.guild.members.me.permissions.has("ManageMessages")) {
      return message.reply("I don't have permission to delete messages.");
    }

    const amount = parseInt(args[0]);
    if (!amount || amount < 1 || amount > 100) {
      return message.reply("Provide a number between **1** and **100**.");
    }

    try {
      await message.channel.bulkDelete(amount, true);
      return message.reply(`🧹 Deleted **${amount}** messages.`)
        .then(msg => setTimeout(() => msg.delete().catch(() => {}), 3000));
    } catch (err) {
      console.error(err);
      return message.reply("I couldn't delete messages here.");
    }
  }

  if (command === "ban") {
    const isOwnerById = message.author.id === ownerId;

    const target = message.mentions.members.first() ||
      message.guild.members.cache.get(args[0]);

    if (!target) {
      return message.reply("Please mention a user or provide their ID.");
    }

    if (target.id === message.author.id) {
      return message.reply("You can't ban yourself.");
    }

    if (target.id === client.user.id) {
      return message.reply("I can't ban myself.");
    }

    if (!isOwnerById) {
      if (!message.member.permissions.has("BanMembers")) {
        return message.reply("You need the **Ban Members** permission to use this command.");
      }
    }

    if (!message.guild.members.me.permissions.has("BanMembers")) {
      return message.reply("I don't have permission to ban members.");
    }

    if (!isOwnerById && target.roles.highest.position >= message.member.roles.highest.position) {
      return message.reply("You can't ban someone with an equal or higher role.");
    }

    const reason = args.slice(1).join(" ") || "No reason provided";

    try {
      await target.ban({ reason });

      const container = new ContainerBuilder()
        .setAccentColor(0x2b2d31)
        .addTextDisplayComponents(t =>
          t.setContent(`🔨 **${target.user.tag}** has been banned.\n**Reason:** ${reason}`)
        );

      return message.reply({
        components: [container],
        flags: MessageFlags.IsComponentsV2
      });
    } catch (err) {
      console.error(err);
      return message.reply("I couldn't ban that user. Check my permissions and role position.");
    }
  }

  if (command === "unban") {
    const isOwnerById = message.author.id === ownerId;

    if (!isOwnerById && !message.member.permissions.has("BanMembers")) {
      return message.reply("You need the **Ban Members** permission to unban users.");
    }

    if (!message.guild.members.me.permissions.has("BanMembers")) {
      return message.reply("I don't have permission to unban members.");
    }

    const userId = args[0];
    if (!userId) return message.reply("Provide a user ID to unban.");

    let bannedUser;
    try {
      bannedUser = await message.guild.bans.fetch(userId);
    } catch {
      return message.reply("That user is not banned or the ID is invalid.");
    }

    const reason = args.slice(1).join(" ") || "No reason provided";

    try {
      await message.guild.members.unban(userId, reason);
      return message.reply(`🔓 Unbanned **${bannedUser.user.tag}**.\n**Reason:** ${reason}`);
    } catch (err) {
      console.error(err);
      return message.reply("I couldn't unban that user.");
    }
  }

  if (command === "unmute") {
    const target = message.mentions.members.first() ||
      message.guild.members.cache.get(args[0]);

    if (!target) return message.reply("Please mention a user or provide their ID.");

    const isOwnerById = message.author.id === ownerId;

    if (!isOwnerById && !message.member.permissions.has("ModerateMembers")) {
      return message.reply("You need the **Moderate Members** permission to unmute users.");
    }

    if (!message.guild.members.me.permissions.has("ModerateMembers")) {
      return message.reply("I don't have permission to unmute members.");
    }

    if (!target.isCommunicationDisabled()) {
      return message.reply("That user is not muted.");
    }

    try {
      await target.timeout(null); // removes timeout
      return message.reply(`🔊 **${target.user.tag}** has been unmuted.`);
    } catch (err) {
      console.error(err);
      return message.reply("I couldn't unmute that user.");
    }
  }

  // PREFIX: stats
  if (command === "stats") {
    const guildCount = client.guilds.cache.size;
    const cachedUserCount = client.users.cache.size;
    const totalMembers = getTotalMembersCount();

    const container = new ContainerBuilder()
      .setAccentColor(0x2b2d31)
      .addTextDisplayComponents(t =>
        t.setContent(
          `📊 **Bot Statistics**\n\n` +
          `• Total Messages Seen: **${botStats.totalMessages}**\n` +
          `• Bot Messages Sent: **${botStats.botMessages}**\n` +
          `• Commands Used: **${botStats.commandsUsed}**\n` +
          `• Unique Users (tracked): **${botStats.uniqueUsers.size}**\n\n` +
          `🌐 **Global Stats**\n` +
          `• Servers: **${guildCount}**\n` +
          `• Total Members (sum of all guilds): **${totalMembers}**\n` +
          `• Cached Users (client.users): **${cachedUserCount}**`
        )
      );

    return message.reply({
      components: [container],
      flags: MessageFlags.IsComponentsV2
    });
  }

  if (command === "uptime") {
    const container = await buildUptimeContainer();

    return message.reply({
      components: [container],
      flags: MessageFlags.IsPersistent | MessageFlags.IsComponentsV2
    });
  }
async function buildUptimeContainer() {
  // BOT UPTIME
  const totalSeconds = Math.floor(process.uptime());
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const botUptime =
    `${days}d ${hours}h ${minutes}m ${seconds}s`;

  // DATABASE UPTIME
  let dbUptime = "Unavailable";

  try {
    const admin = mongoose.connection.db.admin();
    const serverStatus = await admin.serverStatus();

    const dbSeconds = serverStatus.uptime;
    const dbDays = Math.floor(dbSeconds / 86400);
    const dbHours = Math.floor((dbSeconds % 86400) / 3600);
    const dbMinutes = Math.floor((dbSeconds % 3600) / 60);
    const dbSecs = Math.floor(dbSeconds % 60);

    dbUptime = `${dbDays}d ${dbHours}h ${dbMinutes}m ${dbSecs}s`;
  } catch (err) {
    dbUptime = "Error fetching uptime";
  }

  // BUILD UI
  const text =
    `## ⏱ Uptime\n` +
    `**Bot:** ${botUptime}\n` +
    `**Database:** ${dbUptime}`;

  return new ContainerBuilder()
    .setAccentColor(0x2b2d31)
    .addTextDisplayComponents(t => t.setContent(text));
}


  if (command === "time") {
    const mentionedUser = message.mentions.users.first();
    const targetUserId = mentionedUser ? mentionedUser.id : null;

    const { container, hasButtons } = await buildTimeContainer(message.author.id, targetUserId);
    const components = [container];

    if (hasButtons) {
      components.push(buildTimeButtons());
    }

    return message.reply({
      components,
      flags: MessageFlags.IsPersistent | MessageFlags.IsComponentsV2
    });
  }

  if (command === "settz") {
    const container = buildTimezoneContainer(0);
    const dropdown = buildTimezoneDropdown(0);
    const buttons = buildTimezoneButtons(0);

    return message.reply({
      components: [container, dropdown, buttons],
      flags: MessageFlags.IsPersistent | MessageFlags.IsComponentsV2
    });
  }

  if (command === "afk") {
    const reason = args.join(' ');

    await AFK.findOneAndUpdate(
      { userId: message.author.id, guildId: message.guild?.id },
      { userId: message.author.id, guildId: message.guild?.id, reason: reason || null, timestamp: new Date() },
      { upsert: true, new: true }
    );

    const container = new ContainerBuilder();
    const title = new TextDisplayBuilder().setContent("## 💤 AFK Status Set");
    const bodyText = reason
      ? `<@${message.author.id}> is now AFK.\n**Reason:** ${reason}`
      : `<@${message.author.id}> is now AFK.`;
    const body = new TextDisplayBuilder().setContent(bodyText);

    const separator = new SeparatorBuilder()
      .setSpacing(SeparatorSpacingSize.Small)
      .setDivider(true);

    container
      .addTextDisplayComponents(title)
      .addTextDisplayComponents(body)
      .addSeparatorComponents(separator);

    return message.reply({
      components: [container],
      flags: MessageFlags.IsPersistent | MessageFlags.IsComponentsV2,
      allowedMentions: { repliedUser: false }
    });
  }

  if (command === "status") {
    if (!isOwner(message.author.id)) {
      return message.reply("You are not allowed to use this command.");
    }

    const container = buildStatusContainer();
    const dropdown = buildStatusDropdown();

    return message.reply({
      components: [container, dropdown],
      flags: MessageFlags.IsPersistent | MessageFlags.IsComponentsV2
    });
  }
}); // end messageCreate

// ===============================
// INTERACTIONS HANDLER (FULLY FIXED)
// ===============================

client.on("interactionCreate", async interaction => {
  try {

    // ============================
    // SLASH COMMANDS
    // ============================
    if (interaction.isChatInputCommand()) {
      const name = interaction.commandName;

      // HELP
      if (name === "help") {
        const container = buildHelpOverviewContainer();
        const dropdown = buildHelpDropdown();
        return interaction.reply({
          components: [container, dropdown],
          flags: MessageFlags.IsComponentsV2
        });
      }

      // COOKIE LEADERBOARD
      if (name === "cookielb") {
        const top = await Cookie.find().sort({ cookies: -1 }).limit(10);

        if (!top.length) {
          const empty = new ContainerBuilder()
            .setAccentColor(0xF4A261)
            .addTextDisplayComponents(t =>
              t.setContent("## 🍪 Cookie Leaderboard\nNo cookies have been given yet.")
            );

          return interaction.reply({
            components: [empty],
            flags: MessageFlags.IsComponentsV2
          });
        }

        let text = "## 🍪 Cookie Leaderboard\n";
        let rank = 1;

        for (const entry of top) {
          const user = await interaction.client.users.fetch(entry.userId).catch(() => null);
          const name = user ? user.username : `Unknown User (${entry.userId})`;
          text += `**${rank}.** ${name} — **${entry.cookies} cookies**\n`;
          rank++;
        }

        const container = new ContainerBuilder()
          .setAccentColor(0xF4A261)
          .addTextDisplayComponents(t => t.setContent(text));

        return interaction.reply({
          components: [container],
          flags: MessageFlags.IsComponentsV2
        });
      }

if (name === "country") {
  const countryName = interaction.options.getString("name");
  const query = encodeURIComponent(countryName);

  try {
    const res = await fetch(`https://restcountries.com/v3.1/name/${query}`);
    const data = await res.json();

    if (!Array.isArray(data) || !data[0]) {
      return interaction.reply({
        content: "Country not found.",
        flags: MessageFlags.IsEphemeral
      });
    }

    const c = data[0];

    const name = c.name?.common || "Unknown";
    const capital = c.capital?.[0] || "None";
    const region = c.region || "Unknown";
    const population = c.population?.toLocaleString() || "Unknown";
    const currency = c.currencies ? Object.keys(c.currencies)[0] : "Unknown";
    const languages = c.languages ? Object.values(c.languages).join(", ") : "Unknown";
    const flag = c.flags?.png || c.flags?.svg || null;

    const container = new ContainerBuilder()
      .setAccentColor(0x2b2d31)
      .addTextDisplayComponents(t =>
        t.setContent(
          `## 🌍 Country Info: ${name}\n` +
          `**Capital:** ${capital}\n` +
          `**Region:** ${region}\n` +
          `**Population:** ${population}\n` +
          `**Currency:** ${currency}\n` +
          `**Languages:** ${languages}\n` +
          (flag ? `**Flag:** ${flag}` : "")
        )
      );

    return interaction.reply({
      components: [container],
      flags: MessageFlags.IsComponentsV2
    });

  } catch (err) {
    console.error(err);
    return interaction.reply({
      content: "Error fetching country data.",
      flags: MessageFlags.IsEphemeral
    });
  }
}




      if (name === "membercount") {
  const guild = interaction.guild;

  if (!guild) {
    return interaction.reply({
      content: "This command can only be used in a server.",
      flags: MessageFlags.IsEphemeral
    });
  }

  const name = guild.name;
  const count = guild.memberCount;

  const container = new ContainerBuilder()
    .setAccentColor(0x2b2d31)
    .addTextDisplayComponents(t =>
      t.setContent(`## 👥 Member Count\n**Server:** ${name}\n**Members:** ${count}`)
    );

  return interaction.reply({
    components: [container],
    flags: MessageFlags.IsComponentsV2
  });
}

      // STATS
      if (name === "stats") {
        const guildCount = client.guilds.cache.size;
        const cachedUserCount = client.users.cache.size;
        const totalMembers = (typeof getTotalMembersCount === "function")
          ? await getTotalMembersCount()
          : "unknown";

        const container = new ContainerBuilder()
          .setAccentColor(0x2b2d31)
          .addTextDisplayComponents(t =>
            t.setContent(
              `📊 **Bot Statistics**\n\n` +
              `• Total Messages Seen: **${botStats?.totalMessages ?? 0}**\n` +
              `• Bot Messages Sent: **${botStats?.botMessages ?? 0}**\n` +
              `• Commands Used: **${botStats?.commandsUsed ?? 0}**\n` +
              `• Unique Users (tracked): **${botStats?.uniqueUsers?.size ?? 0}**\n\n` +
              `🌐 **Global Stats**\n` +
              `• Servers: **${guildCount}**\n` +
              `• Total Members: **${totalMembers}**\n` +
              `• Cached Users: **${cachedUserCount}**`
            )
          );

        return interaction.reply({
          components: [container],
          flags: MessageFlags.IsComponentsV2
        });
      }




if (interaction.commandName === "map") {
  const name = interaction.options.getString("country");

  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(name)}`);
    const data = await res.json();

    if (!Array.isArray(data) || !data[0]) {
      return interaction.reply("Country not found.");
    }

    const { lat, lon, display_name } = data[0];

    const mapUrl = `https://static-maps.yandex.ru/1.x/?lang=en_US&ll=${lon},${lat}&z=4&size=650,450&l=map`;

    return interaction.reply({
      content: `🗺️ Map of ${display_name}`,
      files: [mapUrl]
    });

  } catch (err) {
    console.error(err);
    return interaction.reply("Failed to fetch the map image.");
  }
}




      // TIMER
      if (name === "timer") {
        const timeArg = interaction.options.getString("time");
        if (!timeArg) {
          return interaction.reply({
            content: "You must provide a time (e.g. 10s, 5m, 2h).",
            flags: MessageFlags.IsEphemeral
          });
        }

        const match = timeArg.match(/(\d+)(s|m|h)/);
        if (!match) {
          return interaction.reply({
            content: "Invalid time format. Use 10s, 5m, 2h.",
            flags: MessageFlags.IsEphemeral
          });
        }

        const amount = parseInt(match[1], 10);
        const unit = match[2];

        const ms =
          unit === "s" ? amount * 1000 :
          unit === "m" ? amount * 60000 :
          amount * 3600000;

        if (Timer) {
          const existing = await Timer.findOne({ userId: interaction.user.id });
          if (existing) {
            return interaction.reply({
              content: "You already have a timer. Use /removetimer.",
              flags: MessageFlags.IsEphemeral
            });
          }
        }

        const endTime = Date.now() + ms;

        if (Timer) {
          await Timer.create({
            userId: interaction.user.id,
            endTime,
            channelId: interaction.channelId
          });
        }

        const container = new ContainerBuilder()
          .setAccentColor(0x2b2d31)
          .addTextDisplayComponents(t =>
            t.setContent(`⏳ Timer set for **${amount}${unit}**.`)
          );

        await interaction.reply({
          components: [container],
          flags: MessageFlags.IsComponentsV2
        });

        setTimeout(async () => {
          try {
            const ch = await client.channels.fetch(interaction.channelId);
            if (ch && ch.send) {
              await ch.send(`<@${interaction.user.id}> Your timer is up!`);
            }
            if (Timer) {
              await Timer.deleteOne({ userId: interaction.user.id });
            }
          } catch (err) {
            console.error("Timer completion send failed:", err);
          }
        }, ms);

        return;
      }

      // REMOVE TIMER
      if (name === "removetimer") {
        if (!Timer) {
          return interaction.reply({
            content: "Timer functionality is not configured.",
            flags: MessageFlags.IsEphemeral
          });
        }

        const existing = await Timer.findOne({ userId: interaction.user.id });
        if (!existing) {
          return interaction.reply({
            content: "You have no active timer.",
            flags: MessageFlags.IsEphemeral
          });
        }

        await Timer.deleteOne({ userId: interaction.user.id });

        const container = new ContainerBuilder()
          .setAccentColor(0xff4444)
          .addTextDisplayComponents(t =>
            t.setContent("🛑 Your timer has been cancelled.")
          );

        return interaction.reply({
          components: [container],
          flags: MessageFlags.IsComponentsV2
        });
      }

      // CHANGELOG
      if (name === "changelog") {
        const container = buildChangelogContainer(0);
        const buttons = buildChangelogButtons(0);

        return interaction.reply({
          components: [container, buttons],
          flags: MessageFlags.IsComponentsV2
        });
      }

      // PING
      if (name === "ping") {
        const now = Date.now();
        const latency = now - interaction.createdTimestamp;
        const wsPing = client.ws.ping;

        const container = buildPingContainer(latency, wsPing);
        const buttons = buildPingButtons();

        return interaction.reply({
          components: [container, buttons],
          flags: MessageFlags.IsComponentsV2
        });
      }

      // UPTIME
      if (name === "uptime") {
        const container = await buildUptimeContainer();
        return interaction.reply({
          components: [container],
          flags: MessageFlags.IsComponentsV2
        });
      }

      // SPOTIFY
      if (name === "spotify") {
        const targetUser = interaction.options.getUser("user");
        let targetMember = interaction.member;

        if (targetUser) {
          targetMember = interaction.guild.members.cache.get(targetUser.id);
          if (!targetMember) {
            return interaction.reply({
              content: "User not found in this server.",
              flags: MessageFlags.IsEphemeral
            });
          }
        }

        const container = buildSpotifyContainer(targetMember);

        return interaction.reply({
          components: [container],
          flags: MessageFlags.IsPersistent | MessageFlags.IsComponentsV2
        });
      }

      // TIME
      if (name === "time") {
        const targetUser = interaction.options.getUser("user");
        const targetUserId = targetUser ? targetUser.id : null;

        const { container, hasButtons } =
          await buildTimeContainer(interaction.user.id, targetUserId);

        const components = [container];
        if (hasButtons) components.push(buildTimeButtons());

        return interaction.reply({
          components,
          flags: MessageFlags.IsComponentsV2
        });
      }

      // SET TIMEZONE
      if (name === "settz") {
        const container = buildTimezoneContainer(0);
        const dropdown = buildTimezoneDropdown(0);
        const buttons = buildTimezoneButtons(0);

        return interaction.reply({
          components: [container, dropdown, buttons],
          flags: MessageFlags.IsComponentsV2
        });
      }

      // AFK
      if (name === "afk") {
        const reason = interaction.options.getString("reason") || null;

        if (AFK) {
          await AFK.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild?.id },
            { userId: interaction.user.id, guildId: interaction.guild?.id, reason, timestamp: new Date() },
            { upsert: true, new: true }
          );
        }

        const container = new ContainerBuilder();
        const title = new TextDisplayBuilder().setContent("## 💤 AFK Status Set");
        const bodyText = reason
          ? `<@${interaction.user.id}> is now AFK.\n**Reason:** ${reason}`
          : `<@${interaction.user.id}> is now AFK.`;
        const body = new TextDisplayBuilder().setContent(bodyText);

        const separator = new SeparatorBuilder()
          .setSpacing(SeparatorSpacingSize.Small)
          .setDivider(true);

        container
          .addTextDisplayComponents(title)
          .addTextDisplayComponents(body)
          .addSeparatorComponents(separator);

        return interaction.reply({
          components: [container],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: { repliedUser: false }
        });
      }

      return;
    }

    // ============================
    // BUTTONS
    // ============================
    if (interaction.isButton()) {
      const cid = interaction.customId;

      // ============================
      // KILL BUTTON HANDLER (FIXED)
      // ============================
      if (cid.startsWith("finishkill_") || cid.startsWith("revive_")) {
        const [action, killerId, targetId] = cid.split("_");

        if (interaction.user.id !== killerId) {
          return interaction.reply({
            content: "You didn’t initiate this kill. Only the original killer can use these buttons.",
            flags: MessageFlags.IsEphemeral
          });
        }

        await interaction.deferUpdate();

        const target = await interaction.client.users.fetch(targetId).catch(() => null);

        const container = new ContainerBuilder()
          .setAccentColor(action === "finishkill" ? 0x990000 : 0x00CC66)
          .addTextDisplayComponents(t =>
            t.setContent(
              action === "finishkill"
                ? `## ☠️ Final Blow\n${target} has been **finished** by ${interaction.user}.`
                : `## ✨ Revival Complete\n${target} has been **revived** by ${interaction.user}.`
            )
          );

        return interaction.message.edit({
          components: [container],
          flags: MessageFlags.IsComponentsV2
        });
      }

      // ============================
      // OTHER BUTTONS (UNCHANGED)
      // ============================

      if (cid.startsWith("changelog_prev:") || cid.startsWith("changelog_next:")) {
        const parts = cid.split(":");
        const currentPage = parseInt(parts[1], 10) || 0;
        const newPage = cid.startsWith("changelog_prev:")
          ? Math.max(0, currentPage - 1)
          : Math.min(changelog.length - 1, currentPage + 1);

        const container = buildChangelogContainer(newPage);
        const buttons = buildChangelogButtons(newPage);

        return interaction.update({
          components: [container, buttons],
          flags: MessageFlags.IsComponentsV2
        });
      }

      if (cid === "ping_refresh_msg") {
        const now = Date.now();
        const latency = now - interaction.createdTimestamp;
        const wsPing = client.ws.ping;

        const container = new ContainerBuilder()
          .setAccentColor(0x2b2d31)
          .addTextDisplayComponents(t =>
            t.setContent(
              `## 🏓 Ping (Updated)\n` +
              `**Latency:** ${latency}ms\n` +
              `**WebSocket:** ${wsPing}ms`
            )
          )
          .addSeparatorComponents(
            new SeparatorBuilder()
              .setSpacing(SeparatorSpacingSize.Small)
              .setDivider(true)
          );

        const buttons = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("ping_refresh_msg")
            .setLabel("Refresh")
            .setStyle(ButtonStyle.Primary)
        );

        return interaction.update({
          components: [container, buttons],
          flags: MessageFlags.IsComponentsV2
        });
      }

      if (cid === "changelog_latest") {
        const container = buildChangelogContainer(0);
        const buttons = buildChangelogButtons(0);

        return interaction.update({
          components: [container, buttons],
          flags: MessageFlags.IsComponentsV2
        });
      }

      if (cid === "time_change") {
        const container = buildTimezoneContainer(0);
        const dropdown = buildTimezoneDropdown(0);
        const buttons = buildTimezoneButtons(0);

        return interaction.update({
          components: [container, dropdown, buttons],
          flags: MessageFlags.IsComponentsV2
        });
      }

      if (cid.startsWith("trust-")) {
        const parts = cid.split("-");
        const action = parts[0];
        const targetId = parts.slice(2).join("-") || parts[2];

        if (action === "trust") {
          if (interaction.user.id !== ownerId && !isOwner?.(interaction.user.id)) {
            return interaction.reply({
              content: "Only the bot owner can confirm trusted access.",
              flags: MessageFlags.IsEphemeral
            });
          }

          trustedUsers.add(targetId);

          const container = new ContainerBuilder()
            .setAccentColor(0x2b2d31)
            .addTextDisplayComponents(t =>
              t.setContent(`✅ <@${targetId}> has been granted trusted access.`)
            );

          return interaction.update({
            components: [container],
            flags: MessageFlags.IsComponentsV2
          });
        }
      }

      if (cid === "time_unlink") {
        if (Timezone) await Timezone.deleteOne({ userId: interaction.user.id });

        const container = new ContainerBuilder();
        const title = new TextDisplayBuilder().setContent("## ✅ Timezone Unlinked");
        const body = new TextDisplayBuilder().setContent(
          "Your timezone has been removed. Use `/settz` or `,settz` to set it again."
        );

        const separator = new SeparatorBuilder()
          .setSpacing(SeparatorSpacingSize.Small)
          .setDivider(true);

        container
          .addTextDisplayComponents(title)
          .addTextDisplayComponents(body)
          .addSeparatorComponents(separator);

        return interaction.update({
          components: [container],
          flags: MessageFlags.IsComponentsV2
        });
      }

      if (cid.startsWith("tz_prev:") || cid.startsWith("tz_next:")) {
        const currentPage = parseInt(cid.split(":")[1], 10) || 0;
        const totalPages = Math.ceil(Object.keys(timezones).length / 25) || 1;
        const newPage = cid.startsWith("tz_prev:")
          ? Math.max(0, currentPage - 1)
          : Math.min(totalPages - 1, currentPage + 1);

        const container = buildTimezoneContainer(newPage);
        const dropdown = buildTimezoneDropdown(newPage);
        const buttons = buildTimezoneButtons(newPage);

        return interaction.update({
          components: [container, dropdown, buttons],
          flags: MessageFlags.IsComponentsV2
        });
      }

      return interaction.reply({
        content: "Unknown button interaction.",
        flags: MessageFlags.IsEphemeral
      });
    }

    // ============================
    // SELECT MENUS
    // ============================
    if (interaction.isStringSelectMenu()) {
      const cid = interaction.customId;

      if (cid === "help_dropdown") {
        const selected = interaction.values[0];
        const container = buildHelpCategoryContainer(selected);
        const dropdown = buildHelpDropdown();

        return interaction.update({
          components: [container, dropdown],
          flags: MessageFlags.IsComponentsV2
        });
      }

      if (cid.startsWith("timezone_select")) {
        const selectedTz = interaction.values[0];

        if (Timezone) {
          await Timezone.findOneAndUpdate(
            { userId: interaction.user.id },
            { userId: interaction.user.id, timezone: selectedTz, lastUpdated: new Date() },
            { upsert: true, new: true }
          );
        }

        const tzDisplay = timezones[selectedTz] || selectedTz;
        const currentTime = (typeof formatTimeInTimezone === "function")
          ? formatTimeInTimezone(selectedTz)
          : "unknown";

        const container = new ContainerBuilder();
        const title = new TextDisplayBuilder().setContent("## ✅ Timezone Set");
        const body = new TextDisplayBuilder().setContent(
          `**Timezone:** ${tzDisplay}\n**Current Time:** ${currentTime}\n\nYou can now use \`/time\` or \`,time\` to check your current time!`
        );

                const separator = new SeparatorBuilder()
          .setSpacing(SeparatorSpacingSize.Small)
          .setDivider(true);

        container
          .addTextDisplayComponents(title)
          .addTextDisplayComponents(body)
          .addSeparatorComponents(separator);

        return interaction.update({
          components: [container],
          flags: MessageFlags.IsComponentsV2
        });
      }

      if (cid === "status_type") {
        const isOwnerUser = interaction.user.id === ownerId || isOwner?.(interaction.user.id);
        const isTrustedUser = trustedUsers.has(interaction.user.id);

        if (!isOwnerUser && !isTrustedUser) {
          return interaction.reply({
            content: "You are not allowed to use this.",
            flags: MessageFlags.IsEphemeral
          });
        }

        const selectedType = interaction.values[0];

        const modal = new ModalBuilder()
          .setCustomId(`status_modal:${selectedType}`)
          .setTitle("Set Bot Status");

        const input = new TextInputBuilder()
          .setCustomId("status_text")
          .setLabel("What should the status say?")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. Minecraft with friends")
          .setRequired(true)
          .setMaxLength(128);

        const row = new ActionRowBuilder().addComponents(input);
        modal.addComponents(row);

        return interaction.showModal(modal);
      }

      return interaction.reply({
        content: "Unknown select interaction.",
        flags: MessageFlags.IsEphemeral
      });
    }

    // ============================
    // MODAL SUBMITS
    // ============================
    if (interaction.isModalSubmit() && interaction.customId.startsWith("status_modal:")) {
      const isOwnerUser = owners.includes(interaction.user.id) || isOwner?.(interaction.user.id);
      const isTrustedUser = trustedUsers.has(interaction.user.id);

      if (!isOwnerUser && !isTrustedUser) {
        return interaction.reply({
          content: "You are not allowed to use this.",
          flags: MessageFlags.IsEphemeral
        });
      }

      const typeKey = interaction.customId.split(":")[1];
      const text = interaction.fields.getTextInputValue("status_text");

      let activityType = ActivityType.Playing;
      switch (typeKey) {
        case "LISTENING":
          activityType = ActivityType.Listening;
          break;
        case "WATCHING":
          activityType = ActivityType.Watching;
          break;
        case "COMPETING":
          activityType = ActivityType.Competing;
          break;
      }

      await client.user.setPresence({
        activities: [{ name: text, type: activityType }],
        status: "idle"
      });

      await interaction.reply({
        content: `Status updated to ${typeKey.toLowerCase()}: ${text}`,
        flags: MessageFlags.IsEphemeral
      });

      const container = new ContainerBuilder();
      const title = new TextDisplayBuilder().setContent("## Status Updated");
      const body = new TextDisplayBuilder().setContent(
        `Status type: ${typeKey.toLowerCase()}\nText: ${text}`
      );

      const separator = new SeparatorBuilder()
        .setSpacing(SeparatorSpacingSize.Small)
        .setDivider(true);

      container
        .addTextDisplayComponents(title)
        .addTextDisplayComponents(body)
        .addSeparatorComponents(separator);

      await interaction.followUp({
        components: [container],
        flags: MessageFlags.IsPersistent | MessageFlags.IsComponentsV2
      });
    }

    } catch (err) {
    console.error("Interaction handler error:", err);
  }
}); // end client.on('interactionCreate')

client.login(token);
