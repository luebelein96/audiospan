/*
 * Minimal Audiospan ABI plugin in plain C with no helper header: a
 * stereo pass-through with one "mute" boolean parameter. Shows exactly what
 * the exports must do. Build:
 *
 *   emcc passthrough.c -I../include -O2 -sSTANDALONE_WASM=1 --no-entry \
 *        -sINITIAL_MEMORY=1048576 -sMAXIMUM_MEMORY=16777216 -sALLOW_MEMORY_GROWTH=1 -o passthrough.wasm
 */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "audiospan/abi.h"

#define MAX_INSTANCES 4

typedef struct {
  int used;
  double mute;
} instance_t;

static instance_t g_instances[MAX_INSTANCES];

static instance_t* get(as_instance_t h) {
  if (h == 0 || h > MAX_INSTANCES || !g_instances[h - 1].used) return NULL;
  return &g_instances[h - 1];
}

AUDIOSPAN_EXPORT(audiospan_get_abi_version)
uint32_t audiospan_get_abi_version(void) { return AUDIOSPAN_ABI_VERSION; }

AUDIOSPAN_EXPORT(audiospan_alloc)
void* audiospan_alloc(uint32_t size, uint32_t alignment) {
  void* p = NULL;
  if (alignment < sizeof(void*)) alignment = sizeof(void*);
  if (posix_memalign(&p, alignment, size ? size : 1) != 0) return NULL;
  return p;
}

AUDIOSPAN_EXPORT(audiospan_free)
void audiospan_free(void* ptr) { free(ptr); }

AUDIOSPAN_EXPORT(audiospan_create)
as_status_t audiospan_create(const as_host_config* config, as_instance_t* out) {
  if (!config || !out || config->struct_size < sizeof(as_host_config)) return AS_ERROR_INVALID_ARGUMENT;
  for (uint32_t i = 0; i < MAX_INSTANCES; ++i) {
    if (g_instances[i].used) continue;
    g_instances[i].used = 1;
    g_instances[i].mute = 0.0;
    *out = i + 1;
    return AS_OK;
  }
  return AS_ERROR_OUT_OF_MEMORY;
}

AUDIOSPAN_EXPORT(audiospan_destroy)
as_status_t audiospan_destroy(as_instance_t h) {
  instance_t* inst = get(h);
  if (!inst) return AS_ERROR_INVALID_ARGUMENT;
  inst->used = 0;
  return AS_OK;
}

AUDIOSPAN_EXPORT(audiospan_reset)
as_status_t audiospan_reset(as_instance_t h) { return get(h) ? AS_OK : AS_ERROR_INVALID_ARGUMENT; }

AUDIOSPAN_EXPORT(audiospan_process)
as_status_t audiospan_process(as_instance_t h, const as_process* p) {
  instance_t* inst = get(h);
  if (!inst || !p || p->struct_size < sizeof(as_process)) return AS_ERROR_INVALID_ARGUMENT;
  if (p->frame_count == 0) return AS_OK;
  if ((p->output_channels && !p->outputs) || (p->input_channels && !p->inputs)) return AS_ERROR_INVALID_ARGUMENT;
  for (uint32_t ch = 0; ch < p->output_channels; ++ch) {
    float* out = p->outputs[ch];
    if (inst->mute >= 0.5 || ch >= p->input_channels) {
      memset(out, 0, p->frame_count * sizeof(float));
    } else {
      memcpy(out, p->inputs[ch], p->frame_count * sizeof(float));
    }
  }
  return AS_OK;
}

AUDIOSPAN_EXPORT(audiospan_set_parameter)
as_status_t audiospan_set_parameter(as_instance_t h, uint32_t index, double value) {
  instance_t* inst = get(h);
  if (!inst || index != 0 || value != value) return AS_ERROR_INVALID_ARGUMENT;
  inst->mute = value >= 0.5 ? 1.0 : 0.0;
  return AS_OK;
}

AUDIOSPAN_EXPORT(audiospan_get_parameter)
as_status_t audiospan_get_parameter(as_instance_t h, uint32_t index, double* out) {
  instance_t* inst = get(h);
  if (!inst || index != 0 || !out) return AS_ERROR_INVALID_ARGUMENT;
  *out = inst->mute;
  return AS_OK;
}

AUDIOSPAN_EXPORT(audiospan_get_state_size)
as_status_t audiospan_get_state_size(as_instance_t h, uint32_t* out_size) {
  if (!get(h) || !out_size) return AS_ERROR_INVALID_ARGUMENT;
  *out_size = 1;
  return AS_OK;
}

AUDIOSPAN_EXPORT(audiospan_get_state)
as_status_t audiospan_get_state(as_instance_t h, uint8_t* dst, uint32_t capacity, uint32_t* out_written) {
  instance_t* inst = get(h);
  if (!inst || !out_written) return AS_ERROR_INVALID_ARGUMENT;
  if (capacity < 1) { *out_written = 0; return AS_ERROR_BUFFER_TOO_SMALL; }
  if (!dst) return AS_ERROR_INVALID_ARGUMENT;
  dst[0] = inst->mute >= 0.5 ? 1 : 0;
  *out_written = 1;
  return AS_OK;
}

AUDIOSPAN_EXPORT(audiospan_set_state)
as_status_t audiospan_set_state(as_instance_t h, const uint8_t* src, uint32_t size) {
  instance_t* inst = get(h);
  if (!inst || (size && !src)) return AS_ERROR_INVALID_ARGUMENT;
  if (size != 1 || src[0] > 1) return AS_ERROR_INVALID_FORMAT;
  inst->mute = src[0] ? 1.0 : 0.0;
  return AS_OK;
}
