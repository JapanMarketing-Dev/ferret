// Pinned download sources for the external tools (docs/06_libraries.md).
// Every sha256 below was verified on 2026-10-11 by downloading the file and hashing it, and cross-checked
// against the publisher's own checksum (GitHub asset digest, BtbN checksums.sha256, martin-riedl .sha256,
// Hugging Face lfs.oid). Exception, hash taken from the publisher only: ggml-large-v3-turbo-q5_0.bin (HF API).

export type ToolName = 'ffmpeg' | 'ffprobe' | 'whisper-cli' | 'whisper-model' | 'whisper-model-small' | 'fonts';
export const TOOL_NAMES: readonly ToolName[] = ['ffmpeg', 'ffprobe', 'whisper-cli', 'whisper-model', 'whisper-model-small', 'fonts'];

export type ToolOs = 'mac' | 'win' | 'linux';
export type ToolArch = 'x64' | 'arm64';

export interface ToolAsset {
  os: ToolOs;
  arch: ToolArch;
  url: string;
  sha256: string;
  kind: 'zip' | 'tar.xz' | 'tar.gz' | 'file' | 'bundle';
  /** Tool name → path inside the extracted archive (for `file`, the file name it is saved as; for `bundle`, a file of the flat dir). */
  bin: Record<string, string>;
  size?: number;
  /** kind 'bundle': several archives whose listed files are copied into one flat folder (fonts + their licenses). */
  parts?: { url: string; sha256: string; kind: 'zip' | 'tar.xz' | 'tar.gz'; size?: number; files: Record<string, string> }[];
}

export interface ToolManifest {
  schema: 1;
  tools: Record<string, { version: string; license?: string; source?: string; assets: ToolAsset[] }>;
}

const BTBN = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08';
const BTBN_VER = 'n9.0.2-17-g2a571b6068';
const MR = 'https://ffmpeg.martin-riedl.de/download/macos';

const HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1';

function btbn(os: ToolOs, arch: ToolArch, plat: string, kind: 'zip' | 'tar.xz', sha256: string, size: number): ToolAsset {
  const dir = `ffmpeg-${BTBN_VER}-${plat}-gpl-9.0`;
  const exe = os === 'win' ? '.exe' : '';
  return {
    os, arch, url: `${BTBN}/${dir}.${kind}`, sha256, kind, size,
    bin: { ffmpeg: `${dir}/bin/ffmpeg${exe}`, ffprobe: `${dir}/bin/ffprobe${exe}` },
  };
}

/** The same file for every platform (models). */
function everywhere(a: Omit<ToolAsset, 'os' | 'arch'>): ToolAsset[] {
  const out: ToolAsset[] = [];
  for (const os of ['mac', 'win', 'linux'] as const) for (const arch of ['x64', 'arm64'] as const) out.push({ ...a, os, arch });
  return out;
}

export const DEFAULT_MANIFEST: ToolManifest = {
  schema: 1,
  tools: {
    // win/linux archives contain both ffmpeg and ffprobe; on macOS they are separate zips (see `ffprobe`).
    ffmpeg: {
      version: '9.0.2',
      license: 'GPL-3.0',
      source: 'https://ffmpeg.org/download.html#get-sources',
      assets: [
        btbn('win', 'x64', 'win64', 'zip', 'a0e45723c72141975f51d8666302e614711745f3102b704ca3f82c897a58d278', 194034585),
        btbn('win', 'arm64', 'winarm64', 'zip', '6dcd0626f9f6d6c7323565e57410e9f37ed14a85946ec9ea9caff294ca32f5c0', 135510041),
        btbn('linux', 'x64', 'linux64', 'tar.xz', '68ee646831adaae2495618346f3bba94ff207ff83bbd34d643e7004730d66269', 151017172),
        btbn('linux', 'arm64', 'linuxarm64', 'tar.xz', '91afcd7695d4bbbb9e0057aa10baaf9875ec4e1a97303f9059ec971336a2ab46', 127445692),
        {
          os: 'mac', arch: 'arm64', url: `${MR}/arm64/1789931890_9.0.2/ffmpeg.zip`, kind: 'zip', size: 28395699,
          sha256: 'c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924', bin: { ffmpeg: 'ffmpeg' },
        },
        {
          os: 'mac', arch: 'x64', url: `${MR}/amd64/1789931006_9.0.2/ffmpeg.zip`, kind: 'zip', size: 33816391,
          sha256: '7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4', bin: { ffmpeg: 'ffmpeg' },
        },
      ],
    },
    ffprobe: {
      version: '9.0.2',
      license: 'GPL-3.0',
      source: 'https://ffmpeg.org/download.html#get-sources',
      assets: [
        {
          os: 'mac', arch: 'arm64', url: `${MR}/arm64/1789931890_9.0.2/ffprobe.zip`, kind: 'zip', size: 28317701,
          sha256: 'fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6', bin: { ffprobe: 'ffprobe' },
        },
        {
          os: 'mac', arch: 'x64', url: `${MR}/amd64/1789931006_9.0.2/ffprobe.zip`, kind: 'zip', size: 33719233,
          sha256: '2322438ed2f6319a691291b247d09c69dcaa3a982460d1f269a7e1af335cfdfd', bin: { ffprobe: 'ffprobe' },
        },
      ],
    },
    // whisper-cli は落とさない。Ferret が同梱・用意したものを FERRET_VIDEO_WHISPER_CLI で渡す（src/video/app/main/cli/env.ts）。
    // 無ければ PATH（brew install whisper-cpp など）を使う。
    // OFL fonts for captions, scenes and thumbnails (docs/06): one flat folder libass / the engine can use as fontsdir.
    // Noto Sans JP static OTF from notofonts/noto-cjk Sans2.004 (subset per language), JetBrains Mono 2.304.
    fonts: {
      version: 'noto-sans-jp-2.004+jetbrains-mono-2.304',
      license: 'OFL-1.1',
      source: 'https://github.com/notofonts/noto-cjk, https://github.com/JetBrains/JetBrainsMono',
      assets: everywhere({
        url: 'bundle:fonts', sha256: '0'.repeat(64), kind: 'bundle',
        bin: { fonts: 'NotoSansJP-Bold.otf' },
        parts: [
          {
            url: 'https://github.com/notofonts/noto-cjk/releases/download/Sans2.004/16_NotoSansJP.zip', kind: 'zip', size: 27139567,
            sha256: '2bbdd2c20f30670b39ca735c96d75f1fdabdb348103e43b820cf17701fd22b18',
            files: {
              'NotoSansJP-Regular.otf': 'NotoSansJP-Regular.otf', 'NotoSansJP-Medium.otf': 'NotoSansJP-Medium.otf',
              'NotoSansJP-Bold.otf': 'NotoSansJP-Bold.otf', 'NotoSansJP-Black.otf': 'NotoSansJP-Black.otf', 'LICENSE-NotoSansJP.txt': 'LICENSE',
            },
          },
          {
            url: 'https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip', kind: 'zip', size: 5622857,
            sha256: '6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf',
            files: { 'JetBrainsMono-Regular.ttf': 'fonts/ttf/JetBrainsMono-Regular.ttf', 'JetBrainsMono-Bold.ttf': 'fonts/ttf/JetBrainsMono-Bold.ttf', 'OFL-JetBrainsMono.txt': 'OFL.txt' },
          },
        ],
      }),
    },
    'whisper-model': {
      version: 'large-v3-turbo-q5_0',
      license: 'MIT',
      source: 'https://huggingface.co/ggerganov/whisper.cpp',
      assets: everywhere({
        url: `${HF}/ggml-large-v3-turbo-q5_0.bin`, kind: 'file', size: 574041195,
        sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
        bin: { 'whisper-model': 'ggml-large-v3-turbo-q5_0.bin' },
      }),
    },
    'whisper-model-small': {
      version: 'small',
      license: 'MIT',
      source: 'https://huggingface.co/ggerganov/whisper.cpp',
      assets: everywhere({
        url: `${HF}/ggml-small.bin`, kind: 'file', size: 487601967,
        sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
        bin: { 'whisper-model-small': 'ggml-small.bin' },
      }),
    },
  },
};
