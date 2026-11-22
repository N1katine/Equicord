/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findComponentByCodeLazy } from "@webpack";
import { ChannelRouter, FluxDispatcher, MediaEngineStore, useEffect, useRef, UserStore, useStateFromStores } from "@webpack/common";
import type { ComponentType } from "react";

import { getWatching, isP2PStream, type Stream, streamKeyFor, useTileStream, watch } from "./net";

interface TileProps {
    participant: { type: number; stream: Stream; };
    selected: boolean;
    width: number;
}

const STREAM_PARTICIPANT = 0;
const Spinner = findComponentByCodeLazy('"pulsingEllipsis"');

export function startWatching(userId: string) {
    if (!watch(userId)) return false;
    const w = getWatching();
    if (!w) return false;
    const { channelId } = w;
    ChannelRouter.transitionToChannel(channelId);
    setTimeout(() => FluxDispatcher.dispatch({ type: "CHANNEL_RTC_SELECT_PARTICIPANT", channelId, id: streamKeyFor(userId, channelId) }));
    return true;
}

function TileVideo({ userId }: { userId: string; }) {
    const src = useTileStream(userId);
    const video = useRef<HTMLVideoElement>(null);
    const isMe = userId === UserStore.getCurrentUser().id;
    const volume = useStateFromStores([MediaEngineStore], () => MediaEngineStore.getLocalVolume(userId, "stream"));
    const muted = useStateFromStores([MediaEngineStore], () => MediaEngineStore.isLocalMute(userId, "stream"));

    useEffect(() => { if (video.current) video.current.srcObject = src; }, [src]);
    useEffect(() => { if (video.current) video.current.volume = Math.min(1, volume / 100); }, [volume]);

    return (
        <div style={{ position: "relative", width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#000" }}>
            <video ref={video} autoPlay playsInline muted={isMe || muted} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
            {!src && <div style={{ position: "absolute" }}><Spinner /></div>}
        </div>
    );
}

export function renderTile({ participant, selected, width }: TileProps, Ended: ComponentType<{ selected: boolean; stream: Stream; width: number; }>) {
    if (participant.type !== STREAM_PARTICIPANT || !isP2PStream(participant.stream)) return null;
    const { ownerId } = participant.stream;
    const w = getWatching();

    if (w?.userId === ownerId && w.ended) return <Ended selected={selected} stream={participant.stream} width={width} />;
    if (selected) return null;
    if (ownerId === UserStore.getCurrentUser().id || w?.userId === ownerId) return <TileVideo userId={ownerId} />;
    return null;
}
