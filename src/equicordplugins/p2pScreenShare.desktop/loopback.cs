/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace P2PAudio
{
    [StructLayout(LayoutKind.Sequential)]
    public struct WaveFormat
    {
        public ushort FormatTag;
        public ushort Channels;
        public uint SamplesPerSec;
        public uint AvgBytesPerSec;
        public ushort BlockAlign;
        public ushort BitsPerSample;
        public ushort Size;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct ActivationParams
    {
        public uint ActivationType;
        public uint TargetProcessId;
        public uint ProcessLoopbackMode;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct Blob
    {
        public int Size;
        public IntPtr Data;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct PropVariant
    {
        [FieldOffset(0)] public ushort Type;
        [FieldOffset(8)] public Blob Blob;
    }

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IActivateAudioInterfaceCompletionHandler
    {
        void ActivateCompleted(IActivateAudioInterfaceAsyncOperation op);
    }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IActivateAudioInterfaceAsyncOperation
    {
        [PreserveSig] int GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    [ComImport, Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAgileObject { }

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, ref WaveFormat format, IntPtr sessionGuid);
        [PreserveSig] int GetBufferSize(out uint size);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int shareMode, ref WaveFormat format, IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }

    public class Handler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public readonly ManualResetEvent Done = new ManualResetEvent(false);
        public int Result;
        public IAudioClient Client;

        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation op)
        {
            int activateResult;
            object iface;
            int hr = op.GetActivateResult(out activateResult, out iface);
            Result = hr != 0 ? hr : activateResult;
            Client = iface as IAudioClient;
            Done.Set();
        }
    }

    public static class Loopback
    {
        [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
        static extern void ActivateAudioInterfaceAsync([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid riid, IntPtr activationParams, IActivateAudioInterfaceCompletionHandler handler, out IActivateAudioInterfaceAsyncOperation op);

        [DllImport("kernel32.dll")]
        static extern IntPtr CreateEvent(IntPtr attributes, bool manualReset, bool initialState, string name);

        [DllImport("kernel32.dll")]
        static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("user32.dll")]
        static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

        const int SampleRate = 48000;
        const int FrameBytes = 4;

        static void Check(int hr, string step)
        {
            if (hr != 0) throw new Exception(step + " failed: 0x" + hr.ToString("X8"));
        }

        static IAudioClient Activate(uint pid, bool include)
        {
            ActivationParams p = new ActivationParams();
            p.ActivationType = 1;
            p.TargetProcessId = pid;
            p.ProcessLoopbackMode = include ? 0u : 1u;
            IntPtr pParams = Marshal.AllocHGlobal(Marshal.SizeOf(p));
            Marshal.StructureToPtr(p, pParams, false);

            PropVariant pv = new PropVariant();
            pv.Type = 65;
            pv.Blob.Size = Marshal.SizeOf(p);
            pv.Blob.Data = pParams;
            IntPtr pPv = Marshal.AllocHGlobal(Marshal.SizeOf(pv));
            Marshal.StructureToPtr(pv, pPv, false);

            Guid iid = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
            Handler handler = new Handler();
            IActivateAudioInterfaceAsyncOperation op;
            ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref iid, pPv, handler, out op);
            handler.Done.WaitOne();
            Check(handler.Result, "Activate");
            return handler.Client;
        }

        public static void Start(string mode, long target, int parentPid)
        {
            uint pid = (uint)target;
            bool include = mode == "window";
            if (include) GetWindowThreadProcessId(new IntPtr(target), out pid);
            if (pid == 0) throw new Exception("No process for target " + target);

            IAudioClient client = Activate(pid, include);
            WaveFormat fmt = new WaveFormat();
            fmt.FormatTag = 1;
            fmt.Channels = 2;
            fmt.SamplesPerSec = SampleRate;
            fmt.BitsPerSample = 16;
            fmt.BlockAlign = FrameBytes;
            fmt.AvgBytesPerSec = SampleRate * FrameBytes;
            const uint LOOPBACK = 0x00020000, EVENTCALLBACK = 0x00040000, AUTOCONVERTPCM = 0x80000000;
            Check(client.Initialize(0, LOOPBACK | EVENTCALLBACK | AUTOCONVERTPCM, 200000, 0, ref fmt, IntPtr.Zero), "Initialize");

            IntPtr ev = CreateEvent(IntPtr.Zero, false, false, null);
            Check(client.SetEventHandle(ev), "SetEventHandle");
            Guid iidCapture = new Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317");
            object service;
            Check(client.GetService(ref iidCapture, out service), "GetService");
            IAudioCaptureClient capture = (IAudioCaptureClient)service;

            Process parent = Process.GetProcessById(parentPid);
            Stream output = Console.OpenStandardOutput();
            Stopwatch clock = Stopwatch.StartNew();
            long written = 0;
            byte[] buffer = new byte[SampleRate * FrameBytes];
            Check(client.Start(), "Start");

            while (!parent.HasExited)
            {
                WaitForSingleObject(ev, 50);
                uint packet;
                while (capture.GetNextPacketSize(out packet) == 0 && packet > 0)
                {
                    IntPtr data;
                    uint frames, flags;
                    ulong devicePosition, qpcPosition;
                    Check(capture.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition), "GetBuffer");
                    int bytes = (int)frames * FrameBytes;
                    if (buffer.Length < bytes) buffer = new byte[bytes];
                    if ((flags & 2) != 0) Array.Clear(buffer, 0, bytes);
                    else Marshal.Copy(data, buffer, 0, bytes);
                    output.Write(buffer, 0, bytes);
                    written += frames;
                    capture.ReleaseBuffer(frames);
                }

                long missing = clock.ElapsedMilliseconds * SampleRate / 1000 - written - SampleRate / 10;
                if (missing > 0)
                {
                    int bytes = (int)Math.Min(missing, SampleRate) * FrameBytes;
                    Array.Clear(buffer, 0, bytes);
                    output.Write(buffer, 0, bytes);
                    written += bytes / FrameBytes;
                }
                output.Flush();
            }
            client.Stop();
        }
    }
}
