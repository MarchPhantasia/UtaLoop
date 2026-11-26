using System.Runtime.InteropServices;
using Microsoft.Web.WebView2.Core;

namespace UtaLoop.Desktop;

// Only the local player document can send PCM to this bridge, including in the practice iframe.
internal sealed class DesktopAudio : IDisposable
{
    private const string Prefix = "utaloop-audio:";
    private const string PlayerPath = "/player.html";
    private readonly HashSet<AudioChannel> channels = new();
    private bool disposed;

    public async Task AttachAsync(CoreWebView2 web)
    {
        var origin = DesktopServices.Origin.GetLeftPart(UriPartial.Authority);
        await web.AddScriptToExecuteOnDocumentCreatedAsync(
            $"if (location.origin === '{origin}' && location.pathname === '{PlayerPath}') window.UtaLoopDesktopAudio = true;");
        if (disposed) return;

        var top = AddChannel();
        web.WebMessageReceived += (_, args) =>
        {
            if (!disposed) top.Receive(args, web.PostWebMessageAsString);
        };
        web.ContentLoading += (_, _) => top.Dispose();
        web.ProcessFailed += (_, _) => ResetChannels();
        web.FrameCreated += (_, args) =>
        {
            if (disposed) return;
            var frame = args.Frame;
            var channel = AddChannel();
            frame.WebMessageReceived += (_, message) =>
            {
                if (!disposed) channel.Receive(message, frame.PostWebMessageAsString);
            };
            frame.ContentLoading += (_, _) => channel.Dispose();
            frame.Destroyed += (_, _) =>
            {
                channel.Dispose();
                channels.Remove(channel);
            };
        };
    }

    private AudioChannel AddChannel()
    {
        var channel = new AudioChannel();
        channels.Add(channel);
        return channel;
    }

    private void ResetChannels()
    {
        foreach (var channel in channels) channel.Dispose();
    }

    public void Dispose()
    {
        disposed = true;
        ResetChannels();
        channels.Clear();
    }

    private sealed class AudioChannel : IDisposable
    {
        private string? activeId;
        private WaveOutput? output;

        public void Receive(CoreWebView2WebMessageReceivedEventArgs args, Action<string> reply)
        {
            if (!Uri.TryCreate(args.Source, UriKind.Absolute, out var uri) || uri.AbsolutePath != PlayerPath ||
                uri.GetLeftPart(UriPartial.Authority) != DesktopServices.Origin.GetLeftPart(UriPartial.Authority)) return;

            string message;
            try { message = args.TryGetWebMessageAsString(); }
            catch (ArgumentException) { return; }

            const int idLength = 32;
            const int encodedLength = (WaveOutput.PacketBytes + 2) / 3 * 4;
            int payloadStart = Prefix.Length + idLength + 1;
            if (message.Length <= payloadStart || !message.StartsWith(Prefix, StringComparison.Ordinal) ||
                message[payloadStart - 1] != ':') return;
            var id = message.Substring(Prefix.Length, idLength);
            if (!Guid.TryParseExact(id, "N", out _)) return;

            int payloadLength = message.Length - payloadStart;
            if (payloadLength == 5 && string.CompareOrdinal(message, payloadStart, "flush", 0, 5) == 0)
            {
                if (activeId == id) output?.Flush();
                return;
            }
            if (payloadLength != encodedLength) return;
            byte[] pcm;
            try { pcm = Convert.FromBase64String(message.Substring(payloadStart)); }
            catch (FormatException) { return; }
            if (pcm.Length != WaveOutput.PacketBytes) return;

            if (id != activeId)
            {
                Dispose();
                activeId = id;
                output = WaveOutput.Open();
            }
            var response = "ack";
            if (output == null || !output.Write(pcm))
            {
                output?.Dispose();
                output = null;
                response = "fallback";
            }
            try { reply(Prefix + id + ":" + response); }
            catch (InvalidOperationException) { Dispose(); }
            catch (COMException) { Dispose(); }
        }

        public void Dispose()
        {
            output?.Dispose();
            output = null;
            activeId = null;
        }
    }
}

// Render from UtaLoop.exe so Windows attributes this audio to the OBS target process.
internal sealed class WaveOutput : IDisposable
{
    private const int SampleRate = 48000;
    private const int BlockAlign = 4;
    internal const int PacketBytes = 512 * BlockAlign;
    private const int BufferCount = 8;
    private const uint HeaderInQueue = 0x10;
    private static readonly uint HeaderSize = (uint)Marshal.SizeOf<WaveHeader>();

    private IntPtr device;
    private readonly byte[] samples = new byte[PacketBytes * BufferCount];
    private readonly WaveHeader[] headers = new WaveHeader[BufferCount];
    private GCHandle samplesPin, headersPin;
    private int prepared;

    public static WaveOutput? Open()
    {
        var output = new WaveOutput();
        var format = new WaveFormat
        {
            FormatTag = 1, Channels = 2, SamplesPerSecond = SampleRate,
            BytesPerSecond = SampleRate * BlockAlign, BlockAlign = BlockAlign, BitsPerSample = 16,
        };
        var result = WaveOutOpen(out var device, uint.MaxValue, ref format, IntPtr.Zero, IntPtr.Zero, 0);
        if (result != 0) return null;
        output.device = device;
        output.samplesPin = GCHandle.Alloc(output.samples, GCHandleType.Pinned);
        output.headersPin = GCHandle.Alloc(output.headers, GCHandleType.Pinned);
        for (var i = 0; i < BufferCount; i++)
        {
            output.headers[i].Data = IntPtr.Add(output.samplesPin.AddrOfPinnedObject(), i * PacketBytes);
            output.headers[i].Length = PacketBytes;
            if (WaveOutPrepareHeader(device, output.HeaderAddress(i), HeaderSize) != 0)
            {
                output.Dispose();
                return null;
            }
            output.prepared++;
        }
        return output;
    }

    public bool Write(byte[] packet)
    {
        for (var i = 0; i < prepared; i++)
        {
            if ((Volatile.Read(ref headers[i].Flags) & HeaderInQueue) != 0) continue;
            Buffer.BlockCopy(packet, 0, samples, i * PacketBytes, PacketBytes);
            return WaveOutWrite(device, HeaderAddress(i), HeaderSize) == 0;
        }
        // Drop excess packets to keep audio close to the media clock if the UI falls behind.
        return true;
    }

    public void Flush()
    {
        if (device != IntPtr.Zero) WaveOutReset(device);
    }

    public void Dispose()
    {
        if (device == IntPtr.Zero) return;
        Flush();
        for (var i = 0; i < prepared; i++) WaveOutUnprepareHeader(device, HeaderAddress(i), HeaderSize);
        // WinMM may still own the buffers if the driver rejects the reset and close.
        if (WaveOutClose(device) != 0) return;
        device = IntPtr.Zero;
        samplesPin.Free();
        headersPin.Free();
    }

    private IntPtr HeaderAddress(int index) => IntPtr.Add(headersPin.AddrOfPinnedObject(), index * (int)HeaderSize);

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    private struct WaveFormat
    {
        public ushort FormatTag, Channels;
        public uint SamplesPerSecond, BytesPerSecond;
        public ushort BlockAlign, BitsPerSample, ExtraSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WaveHeader
    {
        public IntPtr Data;
        public uint Length, BytesRecorded;
        public UIntPtr User;
        public uint Flags, Loops;
        public IntPtr Next;
        public UIntPtr Reserved;
    }

    [DllImport("winmm.dll", EntryPoint = "waveOutOpen")]
    private static extern uint WaveOutOpen(out IntPtr device, uint deviceId, ref WaveFormat format, IntPtr callback, IntPtr instance, uint flags);
    [DllImport("winmm.dll", EntryPoint = "waveOutPrepareHeader")]
    private static extern uint WaveOutPrepareHeader(IntPtr device, IntPtr header, uint size);
    [DllImport("winmm.dll", EntryPoint = "waveOutWrite")]
    private static extern uint WaveOutWrite(IntPtr device, IntPtr header, uint size);
    [DllImport("winmm.dll", EntryPoint = "waveOutReset")]
    private static extern uint WaveOutReset(IntPtr device);
    [DllImport("winmm.dll", EntryPoint = "waveOutUnprepareHeader")]
    private static extern uint WaveOutUnprepareHeader(IntPtr device, IntPtr header, uint size);
    [DllImport("winmm.dll", EntryPoint = "waveOutClose")]
    private static extern uint WaveOutClose(IntPtr device);
}
