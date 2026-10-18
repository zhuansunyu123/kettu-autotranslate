(function (S, O, v, a, U, G, u, y, _, C, ee, ae, B, f) {
    "use strict";

    // ===== Modules =====
    const FluxDispatcher = a.FluxDispatcher;
    const React = a.React;
    const { FormRow, FormSwitchRow } = y.Forms;

    const MessageStore = v.findByStoreName("MessageStore");
    const ChannelStore = v.findByStoreName("ChannelStore");

    // ===== Storage (settings) =====
    const storage = O.storage;
    storage.enabled ??= true;
    storage.target_lang ??= "zh-CN";

    // ===== Translation via Google Translate (free, no key) =====
    async function translate(text, targetLang) {
        const url = "https://translate.googleapis.com/translate_a/single?" + new URLSearchParams({
            client: "gtx",
            sl: "auto",
            tl: targetLang,
            dt: "t",
            dj: "1",
            q: text,
        });
        const res = await (await fetch(url)).json();
        // dj=1 returns { sentences: [{trans}], src }
        const translated = (res.sentences || []).map(s => s.trans).join("");
        const srcLang = res.src || "auto";
        return { text: translated, srcLang };
    }

    // ===== Language detection: skip if already Chinese =====
    function isChinese(text) {
        // If the message contains CJK characters, consider it Chinese (skip)
        // Only translate if there are Latin letters and no CJK
        const hasCJK = /[\u4e00-\u9fff]/.test(text);
        const hasLatin = /[a-zA-Z]/.test(text);
        return hasCJK || !hasLatin;
    }

    // Track translated message IDs to avoid re-translating
    const translatedIds = new Set();

    // Strip Discord markup (mentions, channels, custom emoji) before translating,
    // restore after — same technique as Dislate
    function stripMarkup(text) {
        const placeholders = [];
        const re = /<(a?:\w+:\d+)>|<@!?\d+>|<#\d+>|<t:\d+(?::\w+)?>/g;
        const stripped = text.replace(re, (m) => {
            placeholders.push(m);
            return ` [[${placeholders.length - 1}]] `;
        });
        return { stripped, placeholders };
    }
    function restoreMarkup(text, placeholders) {
        placeholders.forEach((orig, i) => {
            const re = new RegExp(`\\[\\[\\s*${i}\\s*\\]\\]`, "g");
            text = text.replace(re, orig);
        });
        return text;
    }

    async function translateMessage(msg) {
        if (!msg || !msg.content) return;
        if (translatedIds.has(msg.id)) return;
        // Skip embeds-only / empty
        const content = msg.content.trim();
        if (!content) return;
        if (isChinese(content)) return;

        translatedIds.add(msg.id);

        try {
            const { stripped, placeholders } = stripMarkup(content);
            const { text: translated } = await translate(stripped, storage.target_lang);
            if (!translated || !translated.trim()) return;
            const restored = restoreMarkup(translated.trim(), placeholders);

            // Immersive style: original + translation below
            const newContent = `${content}\n${restored} \`[${storage.target_lang}]\``;

            const channel = ChannelStore.getChannel(msg.channel_id);
            FluxDispatcher.dispatch({
                type: "MESSAGE_UPDATE",
                message: {
                    id: msg.id,
                    channel_id: msg.channel_id,
                    guild_id: channel?.guild_id,
                    content: newContent,
                },
                log_edit: false,
                otherPluginBypass: true,
            });
        } catch (e) {
            // Translation failed — remove from set so it can retry next time
            translatedIds.delete(msg.id);
        }
    }

    async function translateChannel(channelId) {
        if (!storage.enabled) return;
        try {
            // getMessages returns array of messages (newest last or first depending on version)
            const messages = MessageStore.getMessages(channelId);
            const arr = messages?._array || messages?.toArray?.() || (Array.isArray(messages) ? messages : []);
            // Only translate the most recent 30 to avoid API spam
            const recent = arr.slice(-30);
            for (const msg of recent) {
                // Small delay to avoid rate limiting
                await translateMessage(msg);
            }
        } catch (e) { /* ignore */ }
    }

    // Debounce rapid channel switches
    let pendingTimer = null;
    function onChannelSelect(action) {
        const channelId = action.channelId;
        if (!channelId) return;
        if (pendingTimer) clearTimeout(pendingTimer);
        // Wait a moment for messages to load
        pendingTimer = setTimeout(() => translateChannel(channelId), 1500);
    }

    // Also translate new incoming messages in the current channel
    function onMessageCreate(action) {
        if (!storage.enabled) return;
        const msg = action.message;
        if (!msg) return;
        // Only auto-translate if it's in the currently viewed channel
        // (avoid translating DMs you're not looking at)
        translateMessage(msg);
    }

    // ===== Settings UI =====
    const Settings = () => {
        B.useProxy(storage);
        const nav = a.NavigationNative.useNavigation();
        return React.createElement(
            a.ReactNative.ScrollView,
            { style: { flex: 1 } },
            React.createElement(FormSwitchRow, {
                label: "自动翻译",
                subLabel: "进帖子自动翻译英文消息",
                value: storage.enabled,
                onValueChange: (v) => { storage.enabled = v; },
            }),
            React.createElement(FormRow, {
                label: "目标语言",
                subLabel: storage.target_lang,
                trailing: () => React.createElement(FormRow.Arrow, null),
                onPress: () => nav.push("VendettaCustomPage", {
                    title: "目标语言",
                    render: LangPicker,
                }),
            })
        );
    };

    const LANGS = [
        ["简体中文", "zh-CN"],
        ["繁體中文", "zh-TW"],
        ["English", "en"],
        ["日本語", "ja"],
        ["한국어", "ko"],
    ];
    const LangPicker = () => {
        B.useProxy(storage);
        return React.createElement(
            a.ReactNative.ScrollView,
            { style: { flex: 1 } },
            LANGS.map(([label, code]) =>
                React.createElement(FormRow, {
                    key: code,
                    label: label + (storage.target_lang === code ? " ✓" : ""),
                    onPress: () => {
                        storage.target_lang = code;
                        // Clear cache so messages re-translate in new language
                        translatedIds.clear();
                        f.showToast(`目标语言: ${label}`, u.getAssetIDByName("check"));
                    },
                })
            )
        );
    };

    // ===== Plugin lifecycle =====
    const plugin = {
        onLoad() {
            FluxDispatcher.subscribe("CHANNEL_SELECT", onChannelSelect);
            FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
        },
        onUnload() {
            FluxDispatcher.unsubscribe("CHANNEL_SELECT", onChannelSelect);
            FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
            if (pendingTimer) clearTimeout(pendingTimer);
            translatedIds.clear();
        },
        settings: Settings,
    };

    S.default = plugin;
    S.settings = storage;
    Object.defineProperty(S, "__esModule", { value: true });
})(
    {},
    vendetta.plugin,
    vendetta.metro,
    vendetta.metro.common,
    vendetta.patcher,
    vendetta.ui,
    vendetta.ui.assets,
    vendetta.ui.components,
    vendetta.utils,
    vendetta,
    vendetta.commands,
    vendetta.ui.alerts,
    vendetta.storage,
    vendetta.ui.toasts
);
