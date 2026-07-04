<script setup lang="ts">
// 启动粒子动画：采样 logo 像素为粒子目标，汇聚成形 → 悬停微浮 → 爆散退场。
// prefers-reduced-motion 时直接跳过；点击可跳过。
import { onBeforeUnmount, onMounted, ref } from 'vue'
import logoRaw from '@/assets/logo-md.svg?raw'

const emit = defineEmits<{ done: [] }>()
const canvas = ref<HTMLCanvasElement | null>(null)
const fading = ref(false)

const CONVERGE_MS = 1150
const HOLD_MS = 420
const BURST_MS = 520

let raf = 0
let finished = false

function finish() {
  if (finished) return
  finished = true
  cancelAnimationFrame(raf)
  fading.value = true
  setTimeout(() => emit('done'), 300)
}

onMounted(async () => {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    finish()
    return
  }
  const cv = canvas.value
  if (!cv) return finish()

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = window.innerWidth
  const h = window.innerHeight
  cv.width = w * dpr
  cv.height = h * dpr
  const ctx = cv.getContext('2d')
  if (!ctx) return finish()
  ctx.scale(dpr, dpr)

  // 1) logo SVG → 离屏 canvas，按网格采样不透明像素作为粒子目标
  let img: HTMLImageElement
  try {
    img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image()
      const url = URL.createObjectURL(new Blob([logoRaw], { type: 'image/svg+xml' }))
      image.onload = () => {
        URL.revokeObjectURL(url)
        resolve(image)
      }
      image.onerror = reject
      image.src = url
    })
  } catch {
    return finish()
  }
  if (finished) return

  const size = Math.min(320, Math.min(w, h) * 0.52)
  const off = document.createElement('canvas')
  off.width = off.height = size
  const octx = off.getContext('2d', { willReadFrequently: true })
  if (!octx) return finish()
  octx.drawImage(img, 0, 0, size, size)
  const data = octx.getImageData(0, 0, size, size).data

  const ox = (w - size) / 2
  const oy = (h - size) / 2 - h * 0.03
  const step = size > 260 ? 4 : 3

  interface P {
    x: number
    y: number
    tx: number
    ty: number
    sx: number
    sy: number
    vx: number
    vy: number
    r: number
    color: string
    delay: number
    phase: number
  }
  const particles: P[] = []
  for (let y = 0; y < size; y += step) {
    for (let x = 0; x < size; x += step) {
      const i = (y * size + x) * 4
      if (data[i + 3] < 140) continue
      const ang = Math.random() * Math.PI * 2
      const dist = Math.max(w, h) * (0.55 + Math.random() * 0.35)
      particles.push({
        tx: ox + x,
        ty: oy + y,
        sx: w / 2 + Math.cos(ang) * dist,
        sy: h / 2 + Math.sin(ang) * dist,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        r: 0.9 + Math.random() * 0.9,
        color: `rgba(${data[i]},${data[i + 1]},${data[i + 2]},`,
        delay: Math.random() * 260,
        phase: Math.random() * Math.PI * 2,
      })
    }
  }

  // 2) 三阶段驱动：汇聚（缓出）→ 悬停（轻微漂浮）→ 爆散（随机速度 + 淡出）
  const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)
  const start = performance.now()

  const tick = (now: number) => {
    const t = now - start
    ctx.clearRect(0, 0, w, h)

    for (const p of particles) {
      let alpha = 1
      if (t < CONVERGE_MS + p.delay) {
        const k = easeOut(Math.min(1, Math.max(0, (t - p.delay) / CONVERGE_MS)))
        p.x = p.sx + (p.tx - p.sx) * k
        p.y = p.sy + (p.ty - p.sy) * k
        alpha = 0.25 + 0.75 * k
      } else if (t < CONVERGE_MS + HOLD_MS + p.delay) {
        const ht = (t - CONVERGE_MS - p.delay) / 320
        p.x = p.tx + Math.sin(ht * 2 + p.phase) * 0.6
        p.y = p.ty + Math.cos(ht * 1.7 + p.phase) * 0.6
      } else {
        if (p.vx === 0 && p.vy === 0) {
          const ang = Math.atan2(p.ty - h / 2, p.tx - w / 2) + (Math.random() - 0.5) * 1.2
          const speed = 3 + Math.random() * 9
          p.vx = Math.cos(ang) * speed
          p.vy = Math.sin(ang) * speed - 2
        }
        p.x += p.vx
        p.y += p.vy
        p.vy += 0.12
        alpha = Math.max(0, 1 - (t - CONVERGE_MS - HOLD_MS - p.delay) / BURST_MS)
      }
      if (alpha <= 0) continue
      ctx.fillStyle = p.color + alpha.toFixed(3) + ')'
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
      ctx.fill()
    }

    if (t > CONVERGE_MS + HOLD_MS + BURST_MS + 380) {
      finish()
      return
    }
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
})

onBeforeUnmount(() => cancelAnimationFrame(raf))
</script>

<template>
  <div class="splash" :class="{ fading }" title="点击跳过" @click="finish">
    <canvas ref="canvas" />
  </div>
</template>

<style scoped>
.splash {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: radial-gradient(120% 90% at 50% 38%, #171d2b 0%, #10141b 55%, #0b0e13 100%);
  cursor: pointer;
  transition: opacity 300ms ease;
}

.splash.fading {
  opacity: 0;
  pointer-events: none;
}

canvas {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
