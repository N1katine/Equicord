/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ConnectSrc, CspPolicies } from "@main/csp";
import { type ChildProcess, spawn } from "child_process";
import { desktopCapturer, type IpcMainInvokeEvent } from "electron";
import loopbackSource from "file://loopback.cs";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

CspPolicies["0.peerjs.com"] = ConnectSrc;
CspPolicies["wss://0.peerjs.com"] = ConnectSrc;

const script = "$ErrorActionPreference='Stop';Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:P2P_CS)) -Language CSharp;[P2PAudio.Loopback]::Start($env:P2P_MODE,[long]$env:P2P_TARGET,[int]$env:P2P_PARENT)";

let helper: ChildProcess | null = null;
let session = 0;
let chunks: Buffer[] = [];
let waiter: ((chunk: Buffer | null) => void) | null = null;

function deliver(chunk: Buffer | null) {
    const w = waiter;
    waiter = null;
    if (w) w(chunk);
    else if (chunk) chunks.push(chunk);
}

export async function getSources(_: IpcMainInvokeEvent) {
    const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } });
    return sources.map(({ id, name }) => ({ id, name }));
}

export function stopAudio(_?: IpcMainInvokeEvent) {
    helper?.kill();
    helper = null;
    chunks = [];
    deliver(null);
}

export function startAudio(_: IpcMainInvokeEvent, sourceId: string) {
    stopAudio();
    const file = join(tmpdir(), "equicord-p2p-loopback.cs");
    writeFileSync(file, loopbackSource);
    const hwnd = /^window:(\d+):/.exec(sourceId)?.[1];

    const child = spawn("powershell.exe", ["-MTA", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
        windowsHide: true,
        env: { ...process.env, P2P_CS: file, P2P_MODE: hwnd ? "window" : "exclude", P2P_TARGET: hwnd ?? String(process.pid), P2P_PARENT: String(process.pid) }
    });
    helper = child;
    child.stdout?.on("data", (chunk: Buffer) => {
        if (helper !== child) return;
        if (chunks.length > 50) chunks.shift();
        deliver(chunk);
    });
    child.stderr?.on("data", (data: Buffer) => console.error("[P2PScreenShare] audio helper:", data.toString()));
    child.on("error", e => {
        console.error("[P2PScreenShare] audio helper:", e);
        if (helper === child) stopAudio();
    });
    child.on("exit", () => { if (helper === child) stopAudio(); });
    return ++session;
}

export function readAudio(_: IpcMainInvokeEvent, id: number): Promise<Buffer | null> {
    if (id !== session || !helper) return Promise.resolve(null);
    if (chunks.length) {
        const chunk = Buffer.concat(chunks);
        chunks = [];
        return Promise.resolve(chunk);
    }
    return new Promise(resolve => { waiter = resolve; });
}
