/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { proxyLazy } from "@utils/lazy";
import { Logger } from "@utils/Logger";
import { PluginNative } from "@utils/types";
import { ApplicationStreamPresets } from "@vencord/discord-types/enums";
import { findLazy } from "@webpack";
import { ApplicationStreamingSettingsStore, ChannelRTCStore, ChannelStore, Flux, FluxDispatcher, SelectedChannelStore, showToast, UserStore, useStateFromStores, VoiceStateStore } from "@webpack/common";

type Message = { t: "state"; viewers: string[]; } | { t: "preview"; img: string; } | { t: "watch"; } | { t: "unwatch"; } | { t: "sdp"; sdp: string; };

interface DataConnection {
    peer: string;
    connectionId: string;
    open: boolean;
    peerConnection: RTCPeerConnection;
    metadata?: { userId?: unknown; };
    send(data: Message): void;
    close(): void;
    on(event: "open" | "close", cb: () => void): void;
    on(event: "data", cb: (data: unknown) => void): void;
    on(event: "iceStateChanged", cb: (state: RTCIceConnectionState) => void): void;
}

type PeerError = { type: string; message: string; };

interface Peer {
    open: boolean;
    disconnected: boolean;
    destroyed: boolean;
    on(event: "open" | "disconnected", cb: () => void): void;
    on(event: "connection", cb: (conn: DataConnection) => void): void;
    on(event: "error", cb: (err: PeerError) => void): void;
    connect(id: string, options: { metadata: { userId: string; }; }): DataConnection | undefined;
    reconnect(): void;
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
    preexisting: boolean;
    stream?: MediaStream;
}

interface Watching {
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

interface StreamAction {
    type: string;
    streamKey?: string;
    channelId?: string;
    sourceId?: string;
    sourceName?: string;
}

const Native = VencordNative.pluginHelpers.P2PScreenShare as PluginNative<typeof import("./native")>;
const logger = new Logger("P2PScreenShare");
const VideoGuard: { k: { getConfig(o: { location: string; }): { videoEnabled: boolean; }; }; } = findLazy(m => typeof m?.M === "string" && m.M.includes("community-in-brazil"));

let peer: Peer | null = null;
let stream: MediaStream | null = null;
let streamChannelId: string | null = null;
let streamToken = 0;
let sourceId: string | null = null;
let previewTimer: ReturnType<typeof setInterval> | undefined;
let myPreview: string | undefined;
const links = new Map<string, DataConnection>();
const viewers = new Set<string>();

let watcher: Peer | null = null;
let watcherChannelId: string | null = null;
let watcherToken = 0;
let probeTimer: ReturnType<typeof setInterval> | undefined;
let warned = false;
const dialing = new Map<string, DataConnection>();
const live = new Map<string, Live>();

const watching = new Map<string, Watching>();

let recaptureTimer: ReturnType<typeof setTimeout> | undefined;
let pendingSource: { id: string; name?: string; } | undefined;
let recaptureQueue: Promise<void> = Promise.resolve();

export const P2PStore = proxyLazy(() => new (class P2PScreenShareStore extends Flux.Store { })(FluxDispatcher));
const notify = () => P2PStore.emitChange();

const me = () => UserStore.getCurrentUser().id;
const peerId = (channelId: string, userId: string) => `eqshare2-${channelId}-${userId}`;
const watchId = (channelId: string, userId: string) => `eqwatch2-${channelId}-${userId}`;
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
    if (d.t === "sdp") return "sdp" in d && typeof d.sdp === "string";
    return d.t === "preview" && "img" in d && typeof d.img === "string" && d.img.startsWith("data:image/jpeg;base64,");
}

export const p2pRoute = () => !VideoGuard.k.getConfig({ location: "P2PScreenShare" }).videoEnabled;
export const isLive = (userId: string) => userId === me() ? streamChannelId != null : live.has(userId);
export const getWatching = (userId: string) => watching.get(userId);
export const myStream = () => streamChannelId ? streamFor(streamChannelId, me()) : null;
export const getGoLiveSource = () => streamChannelId && sourceId ? { desktopSource: { id: sourceId } } : null;

export const isP2PStream = (s: Stream | null) => s != null && p2pStreams.has(s);
export const streamKeyFor = (userId: string, channelId: string) => keyOf(streamFor(channelId, userId));

export function getP2PStream(userId: string, channelId: string) {
    const liveHere = userId === me() ? streamChannelId === channelId : live.has(userId) && watcherChannelId === channelId;
    const w = watching.get(userId);
    const endedHere = w?.ended && w.channelId === channelId;
    return liveHere || endedHere ? streamFor(channelId, userId) : null;
}

export const liveOwnersIn = (channelId: string) => [
    ...(streamChannelId === channelId ? [me()] : []),
    ...(watcherChannelId === channelId ? live.keys() : [])
];
export const activeP2PStreams = () => [myStream(), ...Array.from(watching, ([userId, w]) => streamFor(w.channelId, userId))].filter(s => s != null);
export const isPreexistingLive = (userId: string) => !!live.get(userId)?.preexisting;

export function p2pViewerIds(key: string) {
    if (!isActiveP2PKey(key)) return;
    const { ownerId } = parseKey(key);
    return ownerId === me() ? [...viewers.keys()] : live.get(ownerId)?.viewers ?? [];
}

export function getActiveP2PStream(participant: { stream: Stream; }) {
    if (!isP2PStream(participant.stream)) return null;
    const { ownerId } = participant.stream;
    return { state: watching.get(ownerId)?.ended ? "ENDED" : "ACTIVE" };
}

function isWatcher(userId: string) {
    if (userId === me()) return watching.size > 0;
    return viewers.has(userId) || [...live.values()].some(l => l.viewers.includes(userId));
}

export const useP2P = (userId: string) => ({
    live: useStateFromStores([P2PStore], () => isLive(userId)),
    watching: useStateFromStores([P2PStore], () => isWatcher(userId))
});

export function usePreview<T>(s: Stream, native: T) {
    const preview = useStateFromStores([P2PStore], () => isP2PStream(s) && isLive(s.ownerId) ? (s.ownerId === me() ? myPreview : live.get(s.ownerId)?.preview) ?? null : undefined);
    return preview === undefined ? native : { previewUrl: preview, isLoading: false };
}

export const useTileStream = (userId: string) => useStateFromStores([P2PStore], () => userId === me() ? stream : watching.get(userId)?.stream ?? null);
export const useStreaming = () => useStateFromStores([P2PStore], () => streamChannelId != null);
export const useWatchingIn = (channelId: string) => useStateFromStores([P2PStore, ChannelRTCStore], () => selectedWatched(channelId) != null);

async function loadPeer(): Promise<PeerCtor | undefined> {
    try {
        // @ts-expect-error
        return (await import("https://cdn.jsdelivr.net/npm/peerjs@1.5.5/+esm")).Peer;
    } catch {
        toast("Couldn't load the connection library.");
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
    const w = watching.get(userId);
    if (!w) return;
    w.ended = true;
    refresh(userId, w.channelId);
    notify();
}

export function stopStream() {
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
    myPreview = undefined;
    links.clear();
    viewers.clear();
    dialing.clear();
    notify();
}

function startPreviews(s: MediaStream) {
    const video = document.createElement("video");
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
    if (!viewers.delete(userId)) return;
    const pc = links.get(userId)?.peerConnection;
    if (pc) setTracks(pc, []);
    sendState();
}

function targetKbps() {
    const { resolution, fps } = ApplicationStreamingSettingsStore.getState();
    const base = resolution === 480 ? 1500 : resolution === 720 ? 3000 : resolution === 1080 ? 5000 : 8000;
    return fps >= 60 ? base * 1.5 : base;
}

function tuneAnswer(sdp: string, kbps: number) {
    const lines = sdp.split("\r\n");
    const extra = new Map<string, string>();
    for (const l of lines) {
        const [, pt, codec] = /^a=rtpmap:(\d+) ([\w-]+)\//.exec(l) ?? [];
        if (/^(VP8|VP9|H264|AV1)$/.test(codec)) extra.set(pt, `x-google-start-bitrate=${kbps}`);
        if (codec === "opus") extra.set(pt, "stereo=1;maxaveragebitrate=128000");
    }
    const hasFmtp = new Set(lines.flatMap(l => /^a=fmtp:(\d+) /.exec(l)?.[1] ?? []));
    return lines.flatMap(line => {
        const fmtp = /^a=fmtp:(\d+) /.exec(line)?.[1];
        if (fmtp && extra.has(fmtp)) return [`${line};${extra.get(fmtp)}`];
        const rtpmap = /^a=rtpmap:(\d+) /.exec(line)?.[1];
        if (rtpmap && extra.has(rtpmap) && !hasFmtp.has(rtpmap)) return [line, `a=fmtp:${rtpmap} ${extra.get(rtpmap)}`];
        return [line];
    }).join("\r\n");
}

const HW_CODECS = ["video/AV1", "video/VP9", "video/H264;level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"];
const hwCodecs = new WeakMap<MediaStreamTrack, Promise<string | undefined>>();

async function hardwareCodec(track: MediaStreamTrack, kbps: number) {
    const { width = 1920, height = 1080, frameRate = 30 } = track.getSettings();
    for (const contentType of HW_CODECS) {
        const info = await navigator.mediaCapabilities.encodingInfo({ type: "webrtc", video: { contentType, width, height, framerate: frameRate, bitrate: kbps * 1000 } }).catch(() => null);
        if (info?.supported && info.powerEfficient) return contentType.split(";")[0];
    }
}

async function tuneSender(pc: RTCPeerConnection, kbps: number) {
    const sender = pc.getSenders().find(s => s.track?.kind === "video");
    if (!sender?.track) return;
    if (!hwCodecs.has(sender.track)) hwCodecs.set(sender.track, hardwareCodec(sender.track, kbps));
    const mime = await hwCodecs.get(sender.track);
    const { preset } = ApplicationStreamingSettingsStore.getState();
    const params = sender.getParameters();
    const codec = params.codecs.find(c => c.mimeType === mime);
    params.degradationPreference = preset === ApplicationStreamPresets.PRESET_DOCUMENTS ? "maintain-resolution" : preset === ApplicationStreamPresets.PRESET_VIDEO ? "maintain-framerate" : "balanced";
    params.encodings.forEach((e: RTCRtpEncodingParameters & { codec?: RTCRtpCodecParameters; }) => {
        e.maxBitrate = kbps * 1000;
        if (codec) e.codec = codec;
    });
    await sender.setParameters(params);
    logger.info(codec ? `Requested ${codec.mimeType} (GPU encoder available)` : "No GPU encoder found, using the default codec");
}

function addViewer(conn: DataConnection, userId: string) {
    if (!stream) return;
    viewers.add(userId);
    setTracks(conn.peerConnection, stream.getTracks());
    sendState();
}

function setTracks(pc: RTCPeerConnection, tracks: MediaStreamTrack[]) {
    return Promise.all(["video", "audio"].map(async kind => {
        const track = tracks.find(t => t.kind === kind) ?? null;
        const sender = pc.getTransceivers().find(t => t.receiver.track.kind === kind)?.sender;
        if (sender) await sender.replaceTrack(track);
        else if (track && stream) pc.addTransceiver(track, { direction: "sendonly", streams: [stream] });
    })).catch(e => logger.warn("Could not switch tracks", e));
}

async function negotiate(conn: DataConnection, offer?: string) {
    const pc = conn.peerConnection;
    if (offer) await pc.setRemoteDescription({ type: "offer", sdp: offer });
    await pc.setLocalDescription();
    if (pc.localDescription) conn.send({ t: "sdp", sdp: pc.localDescription.sdp });
}

async function acceptAnswer(pc: RTCPeerConnection, sdp: string) {
    const kbps = targetKbps();
    await pc.setRemoteDescription({ type: "answer", sdp: tuneAnswer(sdp, Math.min(kbps, 5000)) });
    await tuneSender(pc, kbps);
}

async function logRoute(conn: DataConnection, userId: string) {
    const stats = [...(await conn.peerConnection.getStats()).values()];
    const pair = stats.find(s => s.id === stats.find(t => t.type === "transport")?.selectedCandidatePairId);
    if (!pair) return;
    const relayed = stats.some(s => s.candidateType === "relay" && (s.id === pair.localCandidateId || s.id === pair.remoteCandidateId));
    logger.info(`Link with ${userId} is ${relayed ? "relayed through PeerJS's TURN server, quality may suffer" : "direct"}`);
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
        if (!frames && generator.readyState === "live") toast("Couldn't capture your PC audio, streaming video only.");
        generator.stop();
    })().catch(e => logger.error("Audio capture failed", e));

    return generator;
}

async function capture(id: string, name?: string) {
    const { resolution, fps, preset } = ApplicationStreamingSettingsStore.getState();
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
        video.contentHint = preset === ApplicationStreamPresets.PRESET_DOCUMENTS ? "detail" : "motion";
        video.onended = stopStream;
        return { track: video, id: used };
    } catch (e) {
        logger.error(`Could not capture ${id} (${name})`, e);
    }
}

const audioTarget = (id: string) => id.startsWith("window:") ? id : "screen";

async function recapture(id = sourceId, name?: string) {
    if (!stream || !id) return;
    const token = streamToken;
    const c = await capture(id, name);
    if (!c) return;
    if (token !== streamToken || !stream || !sourceId) return c.track.stop();

    const [oldVideo] = stream.getVideoTracks();
    const [oldAudio] = stream.getAudioTracks();
    const { soundshareEnabled } = ApplicationStreamingSettingsStore.getState();
    stream.removeTrack(oldVideo);
    stream.addTrack(c.track);
    oldVideo.stop();
    if (oldAudio && (!soundshareEnabled || audioTarget(c.id) !== audioTarget(sourceId))) {
        stream.removeTrack(oldAudio);
        oldAudio.stop();
        Native.stopAudio();
    }
    if (soundshareEnabled && !stream.getAudioTracks().length) stream.addTrack(loopbackTrack(c.id));
    sourceId = c.id;

    const kbps = targetKbps();
    for (const userId of viewers) {
        const pc = links.get(userId)?.peerConnection;
        if (pc) setTracks(pc, stream.getTracks()).then(() => tuneSender(pc, kbps)).catch(e => logger.warn("Could not tune the video sender", e));
    }
    notify();
}

function scheduleRecapture(source?: { id: string; name?: string; }) {
    if (source) pendingSource = source;
    clearTimeout(recaptureTimer);
    recaptureTimer = setTimeout(() => {
        const src = pendingSource;
        pendingSource = undefined;
        recaptureQueue = recaptureQueue
            .then(() => recapture(src?.id, src?.name))
            .catch(e => logger.error("Recapture failed", e));
    });
}

const prefersExisting = (old: DataConnection | undefined, conn: DataConnection) =>
    old != null && old !== conn && old.open && old.connectionId > conn.connectionId;

function closeWhenDead(conn: DataConnection) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    conn.on("iceStateChanged", state => {
        clearTimeout(timer);
        if (state === "disconnected") timer = setTimeout(() => conn.close(), 10_000);
    });
}

function attachLink(conn: DataConnection, userId: string) {
    closeWhenDead(conn);
    conn.on("open", () => {
        const old = links.get(userId);
        if (prefersExisting(old, conn)) return conn.close();
        links.set(userId, conn);
        if (old !== conn) old?.close();
        conn.peerConnection.onnegotiationneeded = () => negotiate(conn).catch(e => logger.warn("Could not renegotiate the stream", e));
        if (viewers.has(userId) && stream) setTracks(conn.peerConnection, stream.getTracks());
        conn.send({ t: "state", viewers: [...viewers.keys()] });
        if (myPreview) conn.send({ t: "preview", img: myPreview });
        logRoute(conn, userId).catch(() => null);
    });
    conn.on("data", d => {
        if (!isMessage(d) || links.get(userId) !== conn) return;
        if (d.t === "watch") addViewer(conn, userId);
        if (d.t === "unwatch") dropViewer(userId);
        if (d.t === "sdp") acceptAnswer(conn.peerConnection, d.sdp).catch(e => logger.warn("Could not apply the viewer's answer", e));
    });
    conn.on("close", () => {
        if (links.get(userId) !== conn) return;
        links.delete(userId);
        dropViewer(userId);
    });
}

function keepSignaling(p: Peer, fatal: (err: PeerError) => void) {
    let opened = false;
    let delay = 1000;
    p.on("open", () => { opened = true; delay = 1000; });
    p.on("disconnected", () => {
        setTimeout(() => { if (p.disconnected && !p.destroyed) p.reconnect(); }, delay);
        delay = Math.min(delay * 2, 30_000);
    });
    p.on("error", err => {
        if (err.type === "peer-unavailable") {
            const id = err.message.split(" ").pop() ?? "";
            dialing.get(id)?.close();
            dialing.delete(id);
        } else if (opened) logger.warn("Signaling error", err);
        else fatal(err);
    });
}

function dial(p: Peer, id: string) {
    if (!p.open || dialing.has(id)) return;
    const conn = p.connect(id, { metadata: { userId: me() } });
    if (!conn) return;
    dialing.set(id, conn);
    const settle = () => { if (dialing.get(id) === conn) dialing.delete(id); };
    conn.on("open", settle);
    setTimeout(() => {
        if (!conn.open) conn.close();
        settle();
    }, 15_000);
    return conn;
}

function announce(p: Peer, channelId: string) {
    for (const userId of Object.keys(VoiceStateStore.getVoiceStatesForChannel(channelId))) {
        if (userId === me() || links.has(userId)) continue;
        const conn = dial(p, watchId(channelId, userId));
        if (conn) attachLink(conn, userId);
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
    if (token !== streamToken) return c?.track.stop();
    if (!Peer || !c) return stopStream();

    const s = new MediaStream([c.track]);
    if (ApplicationStreamingSettingsStore.getState().soundshareEnabled) s.addTrack(loopbackTrack(c.id));

    const p = new Peer(peerId(channelId, me()));
    keepSignaling(p, err => {
        if (peer !== p) return;
        toast(err.type === "unavailable-id" ? "You're already streaming in another window." : "Couldn't reach the connection server.");
        stopStream();
    });
    p.on("open", () => announce(p, channelId));
    p.on("connection", conn => {
        const userId = conn.metadata?.userId;
        if (typeof userId !== "string" || !VoiceStateStore.getVoiceStateForChannel(channelId, userId)) return conn.close();
        attachLink(conn, userId);
    });

    peer = p;
    stream = s;
    sourceId = c.id;
    startPreviews(s);
    notify();
}

const parseKey = (key = "") => {
    const [channelId, ownerId] = key.split(":").slice(-2);
    return { channelId, ownerId };
};

export function isActiveP2PKey(key: string) {
    const { channelId, ownerId } = parseKey(key);
    if (ownerId === me()) return streamChannelId === channelId;
    return watching.get(ownerId)?.channelId === channelId;
}

function selectedWatched(channelId: string) {
    const { ownerId } = parseKey(ChannelRTCStore.getSelectedParticipantId(channelId) ?? "");
    return watching.get(ownerId)?.channelId === channelId ? ownerId : null;
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
                toast("Pick a screen or window to stream.");
                return true;
            }
            if (streamChannelId) scheduleRecapture({ id: action.sourceId, name: action.sourceName });
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
            if (ownerId !== me()) unwatch(ownerId);
            else if (action.type === "STREAM_STOP") stopStream();
            return true;
        }
        case "MEDIA_ENGINE_SET_GO_LIVE_SOURCE":
            return !!streamChannelId;
        case "STREAM_UPDATE_SETTINGS":
            if (stream) scheduleRecapture();
            return false;
    }
    return false;
}

function attachLive(conn: DataConnection, userId: string, channelId: string, preexisting: boolean) {
    closeWhenDead(conn);
    conn.peerConnection.addEventListener("track", ({ streams: [s] }) => {
        const l = live.get(userId);
        if (l?.conn !== conn) return;
        l.stream = s;
        const w = watching.get(userId);
        if (w) {
            w.stream = s;
            w.ended = false;
        }
        notify();
    });
    conn.on("open", () => {
        const old = live.get(userId);
        if (prefersExisting(old?.conn, conn)) return conn.close();
        live.set(userId, { conn, viewers: old?.viewers ?? [], preview: old?.preview, preexisting: old?.preexisting ?? preexisting });
        if (old && old.conn !== conn) old.conn.close();
        else refresh(userId, channelId);
        notify();
        logRoute(conn, userId).catch(() => null);
    });
    conn.on("data", d => {
        const l = live.get(userId);
        if (l?.conn !== conn || !isMessage(d)) return;
        if (d.t === "state") l.viewers = d.viewers;
        if (d.t === "preview") l.preview = d.img;
        if (d.t === "sdp") negotiate(conn, d.sdp).catch(e => logger.warn("Could not answer the stream offer", e));
        notify();
    });
    conn.on("close", () => {
        if (live.get(userId)?.conn !== conn) return;
        live.delete(userId);
        endWatching(userId);
        refresh(userId, channelId);
        notify();
        setTimeout(() => probe(userId), 3000);
    });
}

function probe(only?: string) {
    if (!watcher || !watcherChannelId) return;
    const w = watcher;
    const channelId = watcherChannelId;

    for (const userId of Object.keys(VoiceStateStore.getVoiceStatesForChannel(channelId))) {
        if (userId === me() || live.has(userId) || (only && userId !== only)) continue;
        const conn = dial(w, peerId(channelId, userId));
        if (conn) attachLive(conn, userId, channelId, true);
    }
}

export function stopWatcher() {
    watcherToken++;
    clearInterval(probeTimer);
    watching.forEach((_, userId) => unwatch(userId));
    live.forEach((_, userId) => refresh(userId, watcherChannelId));
    watcher?.destroy();
    watcher = null;
    watcherChannelId = null;
    live.clear();
    dialing.clear();
    warned = false;
    notify();
}

function createWatcher(Peer: PeerCtor, channelId: string, token: number, named: boolean) {
    const w = new Peer(named ? watchId(channelId, me()) : undefined);
    keepSignaling(w, err => {
        w.destroy();
        if (token !== watcherToken) return;
        if (err.type === "unavailable-id" && named) return createWatcher(Peer, channelId, token, false);
        if (!warned) toast("Couldn't reach the connection server.");
        warned = true;
        setTimeout(() => { if (token === watcherToken) createWatcher(Peer, channelId, token, named); }, 10_000);
    });
    w.on("open", () => probe());
    w.on("connection", conn => {
        const [prefix, chan, userId] = conn.peer.split("-");
        if (prefix !== "eqshare2" || chan !== channelId || !VoiceStateStore.getVoiceStateForChannel(channelId, userId)) return conn.close();
        attachLive(conn, userId, channelId, false);
    });
    watcher = w;
    clearInterval(probeTimer);
    if (!named) probeTimer = setInterval(() => probe(), 30_000);
}

async function startWatcher(channelId: string) {
    stopWatcher();
    const token = watcherToken;
    const Peer = await loadPeer();
    if (!Peer || token !== watcherToken) return;

    createWatcher(Peer, channelId, token, true);
    watcherChannelId = channelId;
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
    if (userId === me()) return true;
    const w = watching.get(userId);
    if (w?.channelId === channelId && !w.ended) return true;

    const l = live.get(userId);
    watching.set(userId, { channelId, stream: l?.stream ?? null, ended: false });
    if (l?.conn.open) l.conn.send({ t: "watch" });
    refresh(userId, channelId);
    notify();
    return true;
}

export function unwatch(userId: string) {
    const w = watching.get(userId);
    if (!w) return false;
    const l = live.get(userId);
    if (l?.conn.open) l.conn.send({ t: "unwatch" });
    refresh(userId, w.channelId);
    watching.delete(userId);
    notify();
    return true;
}

export function unwatchSelected() {
    const ownerId = watcherChannelId && selectedWatched(watcherChannelId);
    return !!ownerId && unwatch(ownerId);
}
