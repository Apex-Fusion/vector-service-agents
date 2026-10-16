// agents/audio-snippets/src/model.ts
// The speech model the service runs (ruling R-D2): its size, from WHISPER_MODEL, base by default; the name the result gives it; and where the image keeps its
// files. The image builds one size in (its build argument WHISPER_MODEL), so the setting and the build must name the same one: the check at start finds the
// model files missing otherwise. The manifest, the gaps and the start read it.
import { shown } from '@vsa/service-kit';

/** The sizes the image can be built with: the two whose files asr/fetch_model.py pins. */
export const WHISPER_SIZES = ['base', 'small'] as const;
export type WhisperSize = (typeof WHISPER_SIZES)[number];
export const WHISPER_SIZE_DEFAULT: WhisperSize = 'base';

/** The size of WHISPER_MODEL: base when absent or empty, base or small in any case, anything else refused with the variable named. */
export function whisperSize(v: string | undefined): WhisperSize {
  const value = (v ?? '').trim().toLowerCase();
  if (value === '') return WHISPER_SIZE_DEFAULT;
  if (!(WHISPER_SIZES as readonly string[]).includes(value)) throw new Error(`environment variable WHISPER_MODEL must be one of ${WHISPER_SIZES.join(', ')}, got ${shown((v ?? '').trim())}`);
  return value as WhisperSize;
}

/** The model the result names: faster-whisper-<size>-int8. */
export const modelName = (size: WhisperSize): string => `faster-whisper-${size}-int8`;
/** Where the image keeps the files of the model: /app/asr/models/<size>. */
export const modelDirOf = (size: WhisperSize): string => `/app/asr/models/${size}`;
