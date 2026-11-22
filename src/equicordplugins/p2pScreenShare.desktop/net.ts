/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { useForceUpdater } from "@utils/react";
import { PluginNative } from "@utils/types";
import { findLazy } from "@webpack";
import { ApplicationStreamingSettingsStore, ChannelStore, FluxDispatcher, SelectedChannelStore, showToast, useEffect, UserStore, VoiceStateStore } from "@webpack/common";

type Message = { t: "state"; viewers: string[]; } | { t: "preview"; img: string; } | { t: "watch"; } | { t: "unwatch"; };

interface DataConnection {
    peer: string;
    connectionId: string;
    open: boolean;
    metadata?: { userId?: unknown; };
    send(data: Message): void;
    close(): void;
    on(event: "open" | "close", cb: () => void): void;
    on(event: "data", cb: (data: unknown) => void): void;
}

interface MediaConnection {
    peer: string;
    peerConnection: RTCPeerConnection;
    answer(): void;
    close(): void;
    on(event: "stream", cb: (stream: MediaStream) => void): void;
    on(event: "close", cb: () => void): void;
}

interface Peer {
    on(event: "open", cb: () => void): void;
    on(event: "connection", cb: (conn: DataConnection) => void): void;
    on(event: "call", cb: (call: MediaConnection) => void): void;
    on(event: "error", cb: (err: { type: string; message: string; }) => void): void;
    connect(id: string, options: { metadata: { userId: string; }; }): DataConnection;
    call(id: string, stream: MediaStream): MediaConnection;
    destroy(): void;
}

type PeerCtor = new (id?: string) => Peer;

declare const MediaStreamTrackGenerator: new (init: { kind: "audio"; }) => MediaStreamTrack & { writable: WritableStream<AudioData>; };

interface DesktopConstraints extends MediaTrackConstraints {
    mandatory: Record<string, string | number>;
}

interface Live {
    conn: DataConnection;
    viewers: string[];
    preview?: string;
}

export interface Watching {
    userId: string;
    channelId: string;
    stream: MediaStream | null;
    ended: boolean;
}

export interface Stream {
    streamType: "guild" | "call";
    guildId: string | null;
    channelId: string;
    ownerId: string;
}

interface GoLiveSettings {
    qualityOptions?: { preset: number; resolution: number; frameRate: number; };
    desktopSettings?: { sourceId: string; sound: boolean; };
}

interface StreamAction {
    type: string;
    streamKey?: string;
    channelId?: string;
    sourceId?: string;
    sourceName?: string;
    settings?: GoLiveSettings | null;
}

const Native = VencordNative.pluginHelpers.P2PScreenShare as PluginNative<typeof import("./native")>;
const logger = new Logger("P2PScreenShare");
const VideoGuard: { k: { getConfig(o: { location: string; }): { videoEnabled: boolean; }; }; } = findLazy(m => typeof m?.M === "string" && m.M.includes("community-in-brazil"));

let peer: Peer | null = null;
let stream: MediaStream | null = null;
let streamChannelId: string | null = null;
let streamToken = 0;
let sourceId: string | null = null;
let previewVideo: HTMLVideoElement | null = null;
let previewTimer: ReturnType<typeof setInterval> | undefined;
let myPreview: string | undefined;
const links = new Map<string, DataConnection>();
const viewers = new Map<string, MediaConnection>();

let watcher: Peer | null = null;
let watcherChannelId: string | null = null;
let watcherToken = 0;
let probeTimer: ReturnType<typeof setInterval> | undefined;
let warned = false;
const pending = new Set<string>();
const live = new Map<string, Live>();

let watching: Watching | null = null;
let watchCall: MediaConnection | null = null;

let recaptureTimer: ReturnType<typeof setTimeout> | undefined;
let pendingGoLive: GoLiveSettings | undefined;
let pendingSource: { id: string; name?: string; } | undefined;
let recaptureQueue: Promise<void> = Promise.resolve();
let applyingSettings = false;

const listeners = new Set<() => void>();
const notify = () => listeners.forEach(l => l());

function useNotify() {
    const rerender = useForceUpdater();
    useEffect(() => {
        listeners.add(rerender);
        return () => { listeners.delete(rerender); };
    }, []);
}

const me = () => UserStore.getCurrentUser().id;
const peerId = (channelId: string, userId: string) => `eqshare-${channelId}-${userId}`;
const watchId = (channelId: string, userId: string) => `eqwatch-${channelId}-${userId}`;
const toast = (text: string) => showToast({ text, variant: "critical" });
const desktop = (extra?: DesktopConstraints["mandatory"]): DesktopConstraints => ({ mandatory: { chromeMediaSource: "desktop", ...extra } });

const p2pStreams = new WeakSet<Stream>();

function streamFor(channelId: string, ownerId: string): Stream {
    const guildId = ChannelStore.getChannel(channelId).guild_id ?? null;
    const s: Stream = { streamType: guildId ? "guild" : "call", guildId, channelId, ownerId };
    p2pStreams.add(s);
    return s;
}

const keyOf = (s: Stream) => s.guildId ? `guild:${s.guildId}:${s.channelId}:${s.ownerId}` : `call:${s.channelId}:${s.ownerId}`;

function refresh(userId: string, channelId: string | null) {
    if (channelId) setTimeout(() => FluxDispatcher.dispatch({ type: "VC_P2P_UPDATE", userId, channelId }));
}

function isMessage(d: unknown): d is Message {
    if (typeof d !== "object" || d === null || !("t" in d)) return false;
    if (d.t === "watch" || d.t === "unwatch") return true;
    if (d.t === "state") return "viewers" in d && Array.isArray(d.viewers) && d.viewers.every(v => typeof v === "string");
    return d.t === "preview" && "img" in d && typeof d.img === "string" && d.img.startsWith("data:image/jpeg;base64,");
}

export const p2pRoute = () => !VideoGuard.k.getConfig({ location: "P2PScreenShare" }).videoEnabled;
export const isLive = (userId: string) => userId === me() ? streamChannelId != null : live.has(userId);
export const getWatching = () => watching;
export const myStream = () => streamChannelId ? streamFor(streamChannelId, me()) : null;
export const getGoLiveSource = () => streamChannelId && sourceId ? { desktopSource: { id: sourceId } } : null;

export const isP2PStream = (s: Stream | null) => s != null && p2pStreams.has(s);
export const streamKeyFor = (userId: string, channelId: string) => keyOf(streamFor(channelId, userId));

export function getP2PStream(userId: string, channelId: string) {
    const liveHere = userId === me() ? streamChannelId === channelId : live.has(userId) && watcherChannelId === channelId;
    const endedHere = watching?.userId === userId && watching.ended && watching.channelId === channelId;
    return liveHere || endedHere ? streamFor(channelId, userId) : null;
}

export function getActiveP2PStream(participant: { stream: Stream; }) {
    if (!isP2PStream(participant.stream)) return null;
    const { ownerId } = participant.stream;
    return { state: watching?.userId === ownerId && watching.ended ? "ENDED" : "ACTIVE" };
}

function isWatcher(userId: string) {
    if (userId === me()) return watching != null;
    return viewers.has(userId) || [...live.values()].some(l => l.viewers.includes(userId));
}

export function useP2P(userId: string) {
    useNotify();
    return { live: isLive(userId), watching: isWatcher(userId) };
}

export function usePreview<T>(s: Stream, native: T) {
    useNotify();
    if (!isP2PStream(s) || !isLive(s.ownerId)) return native;
    return { previewUrl: (s.ownerId === me() ? myPreview : live.get(s.ownerId)?.preview) ?? null, isLoading: false };
}

export function useTileStream(userId: string) {
    useNotify();
    return userId === me() ? stream : watching?.stream ?? null;
}

export function useStreaming() {
    useNotify();
    return streamChannelId != null;
}

export function useWatchingIn(channelId: string) {
    useNotify();
    return watching?.channelId === channelId;
}

async function loadPeer(): Promise<PeerCtor | undefined> {
    try {
        // @ts-expect-error
        return (await import("https://cdn.jsdelivr.net/npm/peerjs@1.5.5/+esm")).Peer;
    } catch {
        toast("Não consegui carregar a biblioteca de conexão.");
    }
}

function broadcast(msg: Message) {
    links.forEach(c => c.open && c.send(msg));
}

function sendState() {
    broadcast({ t: "state", viewers: [...viewers.keys()] });
    notify();
}

function endWatching(userId: string) {
    if (watching?.userId !== userId) return;
    watching.ended = true;
    watchCall = null;
    refresh(userId, watching.channelId);
    notify();
}

export function stopStream() {
    if (watching?.userId === me()) unwatch();
    refresh(me(), streamChannelId);
    streamToken++;
    clearInterval(previewTimer);
    Native.stopAudio();
    peer?.destroy();
    stream?.getTracks().forEach(t => t.stop());
    peer = null;
    stream = null;
    streamChannelId = null;
    sourceId = null;
    previewVideo = null;
    myPreview = undefined;
    links.clear();
    viewers.clear();
    notify();
}

function startPreviews(s: MediaStream) {
    const video = previewVideo = document.createElement("video");
    const canvas = document.createElement("canvas");
    video.muted = true;
    video.srcObject = s;
    video.play();

    const snap = () => {
        if (!video.videoWidth) return;
        canvas.width = 320;
        canvas.height = Math.round(320 * video.videoHeight / video.videoWidth);
        canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
        myPreview = canvas.toDataURL("image/jpeg", 0.7);
        broadcast({ t: "preview", img: myPreview });
        notify();
    };
    setTimeout(snap, 1000);
    previewTimer = setInterval(snap, 10_000);
}

function dropViewer(userId: string) {
    const call = viewers.get(userId);
    if (!call) return;
    viewers.delete(userId);
    call.close();
    sendState();
}

function targetKbps() {
    const { resolution, fps } = ApplicationStreamingSettingsStore.getState();
    const base = resolution === 480 ? 1500 : resolution === 720 ? 3000 : resolution === 1080 ? 5000 : 8000;
    return fps >= 60 ? base * 1.5 : base;
}

function withStartBitrate(sdp: string, kbps: number) {
    const lines = sdp.split("\r\n");
    const video = new Set(lines.flatMap(l => /^a=rtpmap:(\d+) (?:VP8|VP9|H264|AV1)\/90000/.exec(l)?.[1] ?? []));
    const hasFmtp = new Set(lines.flatMap(l => /^a=fmtp:(\d+) /.exec(l)?.[1] ?? []));
    const param = `x-google-start-bitrate=${kbps}`;
    return lines.flatMap(line => {
        const fmtp = /^a=fmtp:(\d+) /.exec(line)?.[1];
        if (fmtp && video.has(fmtp)) return [`${line};${param}`];
        const rtpmap = /^a=rtpmap:(\d+) /.exec(line)?.[1];
        if (rtpmap && video.has(rtpmap) && !hasFmtp.has(rtpmap)) return [line, `a=fmtp:${rtpmap} ${param}`];
        return [line];
    }).join("\r\n");
}

function tuneSender(pc: RTCPeerConnection, kbps: number) {
    for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== "video") continue;
        const params: RTCRtpSendParameters & { degradationPreference?: string; } = sender.getParameters();
        params.degradationPreference = "maintain-resolution";
        params.encodings.forEach(e => { e.maxBitrate = kbps * 1000; });
        sender.setParameters(params).catch(e => logger.warn("Could not tune the video sender", e));
    }
}

function addViewer(conn: DataConnection, userId: string) {
    if (!peer || !stream) return;
    const old = viewers.get(userId);
    const call = peer.call(conn.peer, stream);
    viewers.set(userId, call);
    old?.close();

    const kbps = targetKbps();
    const pc = call.peerConnection;
    const setRemote = pc.setRemoteDescription.bind(pc);
    pc.setRemoteDescription = async (desc: RTCSessionDescriptionInit) => {
        await setRemote({ type: desc.type, sdp: desc.sdp && withStartBitrate(desc.sdp, Math.min(kbps, 5000)) });
        tuneSender(pc, kbps);
    };
    call.on("close", () => { if (viewers.get(userId) === call) dropViewer(userId); });
    sendState();
}

function pickSource(sources: { id: string; name: string; }[], id: string, name?: string) {
    const byName = sources.find(s => s.name === name);
    if (byName) return byName;
    const screen = /^Screen (\d+)$/.exec(name ?? "")?.[1];
    if (!screen && !id.startsWith("screen")) return;
    const screens = sources.filter(s => s.id.startsWith("screen:"));
    return screens[Number(screen ?? 1) - 1] ?? screens[0];
}

function loopbackTrack(sourceId: string) {
    const generator = new MediaStreamTrackGenerator({ kind: "audio" });
    const writer = generator.writable.getWriter();

    (async () => {
        const id = await Native.startAudio(sourceId);
        let frames = 0;
        let rest = new Uint8Array(0);
        for (let chunk = await Native.readAudio(id); chunk && generator.readyState === "live"; chunk = await Native.readAudio(id)) {
            const data = new Uint8Array(rest.length + chunk.byteLength);
            data.set(rest);
            data.set(chunk, rest.length);
            const n = Math.floor(data.length / 4);
            rest = data.slice(n * 4);
            if (!n) continue;
            await writer.write(new AudioData({ format: "s16", sampleRate: 48000, numberOfChannels: 2, numberOfFrames: n, timestamp: frames * 1e6 / 48000, data: data.subarray(0, n * 4) }));
            frames += n;
        }
        if (!frames && generator.readyState === "live") toast("Não consegui capturar o áudio do PC, transmitindo só a imagem.");
        generator.stop();
    })().catch(e => logger.error("Audio capture failed", e));

    return generator;
}

async function capture(id: string, name?: string) {
    const { resolution, fps, soundshareEnabled } = ApplicationStreamingSettingsStore.getState();
    const size: DesktopConstraints["mandatory"] = resolution ? { maxHeight: resolution, maxWidth: Math.round(resolution * 16 / 9) } : {};
    const get = (sid: string) => navigator.mediaDevices.getUserMedia({ video: desktop({ chromeMediaSourceId: sid, maxFrameRate: fps, ...size }) });

    try {
        let used = id;
        const s = await get(id).catch(async (e: unknown) => {
            const fallback = pickSource(await Native.getSources(), id, name);
            logger.warn(`Capture of ${id} (${name}) failed, falling back to ${fallback?.id} (${fallback?.name})`, e);
            if (!fallback) throw e;
            used = fallback.id;
            return get(fallback.id);
        });
        const [video] = s.getVideoTracks();
        video.contentHint = "motion";
        video.onended = stopStream;
        if (soundshareEnabled) s.addTrack(loopbackTrack(used));
        return { stream: s, id: used };
    } catch (e) {
        logger.error(`Could not capture ${id} (${name})`, e);
    }
}

async function recapture(id = sourceId, name?: string) {
    if (!stream || !id) return;
    const c = await capture(id, name);
    if (!c) return;
    if (!stream) return c.stream.getTracks().forEach(t => t.stop());

    const old = stream;
    stream = c.stream;
    sourceId = c.id;
    if (previewVideo) previewVideo.srcObject = c.stream;
    if (watching?.userId === me()) watching.stream = c.stream;
    links.forEach((conn, userId) => { if (viewers.has(userId)) addViewer(conn, userId); });
    old.getTracks().forEach(t => t.stop());
    notify();
}

function scheduleRecapture(settings?: GoLiveSettings, source?: { id: string; name?: string; }) {
    if (settings) pendingGoLive = settings;
    if (source) pendingSource = source;
    clearTimeout(recaptureTimer);
    recaptureTimer = setTimeout(() => {
        const g = pendingGoLive;
        const src = pendingSource;
        pendingGoLive = undefined;
        pendingSource = undefined;
        const q = g?.qualityOptions;
        if (q) {
            applyingSettings = true;
            FluxDispatcher.dispatch({ type: "STREAM_UPDATE_SETTINGS", preset: q.preset, resolution: q.resolution, frameRate: q.frameRate, soundshareEnabled: g.desktopSettings?.sound });
            applyingSettings = false;
        }
        recaptureQueue = recaptureQueue
            .then(() => recapture(src?.id ?? g?.desktopSettings?.sourceId, src?.name))
            .catch(e => logger.error("Recapture failed", e));
    });
}

const prefersExisting = (old: DataConnection | undefined, conn: DataConnection) =>
    old != null && old !== conn && old.open && old.connectionId > conn.connectionId;

function attachLink(conn: DataConnection, userId: string) {
    conn.on("open", () => {
        const old = links.get(userId);
        if (prefersExisting(old, conn)) return conn.close();
        links.set(userId, conn);
        if (old !== conn) old?.close();
        conn.send({ t: "state", viewers: [...viewers.keys()] });
        if (myPreview) conn.send({ t: "preview", img: myPreview });
    });
    conn.on("data", d => {
        if (!isMessage(d) || links.get(userId) !== conn) return;
        if (d.t === "watch") addViewer(conn, userId);
        if (d.t === "unwatch") dropViewer(userId);
    });
    conn.on("close", () => {
        if (links.get(userId) !== conn) return;
        links.delete(userId);
        dropViewer(userId);
    });
}

function announce(p: Peer, channelId: string) {
    for (const userId of Object.keys(VoiceStateStore.getVoiceStatesForChannel(channelId))) {
        if (userId !== me()) attachLink(p.connect(watchId(channelId, userId), { metadata: { userId: me() } }), userId);
    }
}

async function share(channelId: string, id: string, name?: string) {
    const token = ++streamToken;
    streamChannelId = channelId;
    sourceId = id;
    refresh(me(), channelId);
    notify();

    const Peer = await loadPeer();
    const c = Peer && await capture(id, name);
    if (token !== streamToken) return c?.stream.getTracks().forEach(t => t.stop());
    if (!Peer || !c) return stopStream();

    const p = new Peer(peerId(channelId, me()));
    p.on("open", () => announce(p, channelId));
    p.on("connection", conn => {
        const userId = conn.metadata?.userId;
        if (typeof userId !== "string" || !VoiceStateStore.getVoiceStateForChannel(channelId, userId)) return conn.close();
        attachLink(conn, userId);
    });
    p.on("error", err => {
        if (err.type === "peer-unavailable") return;
        if (err.type !== "unavailable-id") return toast("Não consegui falar com o servidor de conexão.");
        toast("Você já está transmitindo em outra janela.");
        stopStream();
    });

    peer = p;
    stream = c.stream;
    sourceId = c.id;
    startPreviews(c.stream);
    notify();
}

const parseKey = (key = "") => {
    const [channelId, ownerId] = key.split(":").slice(-2);
    return { channelId, ownerId };
};

export function isActiveP2PKey(key: string) {
    const { channelId, ownerId } = parseKey(key);
    if (ownerId === me()) return streamChannelId === channelId;
    return watching != null && watching.userId === ownerId && watching.channelId === channelId;
}

function ownedP2PKey(key: string | undefined) {
    const { channelId, ownerId } = parseKey(key);
    return ownerId && channelId && getP2PStream(ownerId, channelId) ? ownerId : null;
}

export function interceptStreamActions(action: StreamAction) {
    switch (action.type) {
        case "STREAM_START": {
            if (!p2pRoute() || !action.channelId) return false;
            if (!action.sourceId) {
                toast("Escolha uma tela ou janela para transmitir.");
                return true;
            }
            if (streamChannelId) scheduleRecapture(undefined, { id: action.sourceId, name: action.sourceName });
            else share(action.channelId, action.sourceId, action.sourceName);
            return true;
        }
        case "STREAM_WATCH": {
            const ownerId = ownedP2PKey(action.streamKey);
            if (!ownerId) return false;
            watch(ownerId);
            return true;
        }
        case "STREAM_STOP":
        case "STREAM_CLOSE": {
            const ownerId = ownedP2PKey(action.streamKey);
            if (!ownerId) return false;
            if (ownerId !== me()) unwatch();
            else if (action.type === "STREAM_STOP") stopStream();
            return true;
        }
        case "MEDIA_ENGINE_SET_GO_LIVE_SOURCE":
            if (!streamChannelId) return false;
            if (action.settings) scheduleRecapture(action.settings);
            return true;
        case "STREAM_UPDATE_SETTINGS":
            if (stream && !applyingSettings) scheduleRecapture();
            return false;
    }
    return false;
}

function attachLive(conn: DataConnection, userId: string, channelId: string) {
    conn.on("open", () => {
        pending.delete(userId);
        const old = live.get(userId);
        if (prefersExisting(old?.conn, conn)) return conn.close();
        live.set(userId, { conn, viewers: old?.viewers ?? [], preview: old?.preview });
        if (old && old.conn !== conn) old.conn.close();
        else refresh(userId, channelId);
        notify();
    });
    conn.on("data", d => {
        const l = live.get(userId);
        if (l?.conn !== conn || !isMessage(d)) return;
        if (d.t === "state") l.viewers = d.viewers;
        if (d.t === "preview") l.preview = d.img;
        notify();
    });
    conn.on("close", () => {
        pending.delete(userId);
        if (live.get(userId)?.conn !== conn) return;
        live.delete(userId);
        endWatching(userId);
        refresh(userId, channelId);
        notify();
    });
}

function probe() {
    if (!watcher || !watcherChannelId) return;
    const w = watcher;
    const channelId = watcherChannelId;

    for (const userId of Object.keys(VoiceStateStore.getVoiceStatesForChannel(channelId))) {
        if (userId === me() || live.has(userId) || pending.has(userId)) continue;

        pending.add(userId);
        const conn = w.connect(peerId(channelId, userId), { metadata: { userId: me() } });
        setTimeout(() => {
            if (conn.open) return;
            conn.close();
            pending.delete(userId);
        }, 15_000);
        attachLive(conn, userId, channelId);
    }
}

export function stopWatcher() {
    watcherToken++;
    clearInterval(probeTimer);
    unwatch();
    live.forEach((_, userId) => refresh(userId, watcherChannelId));
    watcher?.destroy();
    watcher = null;
    watcherChannelId = null;
    live.clear();
    pending.clear();
    warned = false;
    notify();
}

function createWatcher(Peer: PeerCtor, channelId: string, token: number, named: boolean) {
    const w = new Peer(named ? watchId(channelId, me()) : undefined);
    w.on("open", probe);
    w.on("connection", conn => {
        const [prefix, chan, userId] = conn.peer.split("-");
        if (prefix !== "eqshare" || chan !== channelId || !VoiceStateStore.getVoiceStateForChannel(channelId, userId)) return conn.close();
        attachLive(conn, userId, channelId);
    });
    w.on("error", err => {
        if (err.type === "peer-unavailable") return pending.delete(err.message.split("-").pop() ?? "");
        if (err.type === "unavailable-id" && named && token === watcherToken) {
            w.destroy();
            return createWatcher(Peer, channelId, token, false);
        }
        if (warned) return;
        warned = true;
        toast("Não consegui falar com o servidor de conexão.");
    });
    w.on("call", call => {
        const userId = call.peer.split("-")[2];
        if (watching?.userId !== userId) return call.close();
        watchCall = call;
        call.answer();
        call.on("stream", s => {
            if (watching?.userId !== userId) return;
            watching.stream = s;
            watching.ended = false;
            notify();
        });
        call.on("close", () => { if (watchCall === call) endWatching(userId); });
    });
    watcher = w;
}

async function startWatcher(channelId: string) {
    stopWatcher();
    const token = watcherToken;
    const Peer = await loadPeer();
    if (!Peer || token !== watcherToken) return;

    createWatcher(Peer, channelId, token, true);
    watcherChannelId = channelId;
    probeTimer = setInterval(probe, 5000);
}

export function onVoiceChannel(channelId: string | null) {
    if (streamChannelId && channelId !== streamChannelId) stopStream();
    if (channelId === watcherChannelId) return;
    if (channelId) startWatcher(channelId);
    else stopWatcher();
}

export function watch(userId: string) {
    const channelId = SelectedChannelStore.getVoiceChannelId();
    if (!channelId || !isLive(userId)) return false;

    unwatch();
    watching = { userId, channelId, stream: userId === me() ? stream : null, ended: false };
    const l = live.get(userId);
    if (l?.conn.open) l.conn.send({ t: "watch" });
    refresh(userId, channelId);
    notify();
    return true;
}

export function unwatch() {
    if (!watching) return false;
    const l = live.get(watching.userId);
    if (l?.conn.open) l.conn.send({ t: "unwatch" });
    watchCall?.close();
    watchCall = null;
    refresh(watching.userId, watching.channelId);
    watching = null;
    notify();
    return true;
}
