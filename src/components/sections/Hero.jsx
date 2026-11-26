import { useLayoutEffect, useRef } from 'react'
import { ArrowDown, ArrowUpRight } from 'lucide-react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import './Hero.css'

gsap.registerPlugin(ScrollTrigger)

const SCENES = ['hero1', 'hero2', 'hero3']
const SCENE_LENGTH = 190
const LAST_FRAME = SCENES.length * SCENE_LENGTH - 1
const MAX_REQUESTS = 4
const SCENE_BOUNDARIES = SCENES.slice(1).map((_, index) => (index + 1) * SCENE_LENGTH)

function frameUrl(index) {
  const scene = SCENES[Math.floor(index / SCENE_LENGTH)]
  const number = String(index % SCENE_LENGTH + 1).padStart(6, '0')
  return `${import.meta.env.BASE_URL}${scene}/frame_${number}.png`
}

function getFrameLayout(context, bitmap, viewport) {
  const { width, height, copyBottom } = viewport
  const top = copyBottom + height * 0.025
  const availableHeight = Math.max(1, height * 0.93 - top)
  const cover = Math.max(width / bitmap.width, availableHeight / bitmap.height)
  // Keep the entire source height for airborne ingredients. Allow a small
  // horizontal bleed on landscape screens; portrait keeps the full frame.
  const safeWidth = bitmap.width * (width > height ? 0.97 : 1)
  const scale = Math.min(cover, width / safeWidth, availableHeight / bitmap.height)
  const frameWidth = bitmap.width * scale
  const frameHeight = bitmap.height * scale
  const x = (width - frameWidth) / 2
  const y = top + (availableHeight - frameHeight) * (width < height ? 0.36 : 0.48)
  const right = x + frameWidth
  const bottom = y + frameHeight

  // Feather the source edges into the black canvas without masking the center.
  const edgeX = frameWidth * 0.045
  const edgeY = frameHeight * 0.05
  const topFeather = frameHeight * 0.08
  const edges = [
    [x, y, edgeX, frameHeight, x, y, x + edgeX, y],
    [right - edgeX, y, edgeX, frameHeight, right, y, right - edgeX, y],
    [x, y, frameWidth, topFeather, x, y, x, y + topFeather],
    [x, bottom - edgeY, frameWidth, edgeY, x, bottom, x, bottom - edgeY],
  ].map(([left, top, width, height, x0, y0, x1, y1]) => {
    const gradient = context.createLinearGradient(x0, y0, x1, y1)
    gradient.addColorStop(0, '#000')
    gradient.addColorStop(0.7, 'rgb(0 0 0 / 0.15)')
    gradient.addColorStop(1, 'transparent')
    return { left, top, width, height, gradient }
  })

  return { x, y, frameWidth, frameHeight, edges }
}

function createFramePlayer(canvas, copy, status, reducedMotion) {
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) {
    status.textContent = 'Cake preview unavailable'
    return
  }

  const compact = window.matchMedia('(max-width: 767px)').matches
  const cacheLimit = compact ? 22 : 30
  const decodeOptions = compact ? { resizeWidth: 768, resizeQuality: 'high' } : undefined
  const cache = new Map()
  const pending = new Map()
  const failed = new Set()
  let priorities = new Set()
  let target = reducedMotion ? LAST_FRAME : 0
  let destination = target
  let direction = 1
  let step = 1
  let displayed
  let disposed = false
  let scheduled = false
  let resizePending = false
  let viewport
  let layout

  function draw(resize = false) {
    let frame = cache.has(target) ? target : displayed
    if (frame !== target) {
      for (const index of cache.keys()) {
        // During a cache miss, approach the playhead from the displayed frame.
        // Late arrivals on the opposite side can otherwise cause backtracking.
        if (displayed !== undefined && (index - displayed) * (index - target) > 0) continue
        if (frame === undefined || Math.abs(index - target) < Math.abs(frame - target)) {
          frame = index
        }
      }
    }
    const bitmap = cache.get(frame)
    if (!viewport || !bitmap || (!resize && frame === displayed)) return

    layout ??= getFrameLayout(context, bitmap, viewport)
    const { x, y, frameWidth, frameHeight, edges } = layout
    context.fillStyle = '#000'
    context.fillRect(0, 0, viewport.width, viewport.height)
    context.drawImage(bitmap, x, y, frameWidth, frameHeight)
    for (const edge of edges) {
      context.fillStyle = edge.gradient
      context.fillRect(edge.left, edge.top, edge.width, edge.height)
    }
    displayed = frame
    status.hidden = true
  }

  function resizeCanvas() {
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (!width || !height) return

    const copyBottom = copy.offsetTop + copy.offsetHeight
    const dpr = Math.min(window.devicePixelRatio || 1, width < 768 ? 1.5 : 2,
      Math.sqrt(3_000_000 / (width * height)))
    const pixelWidth = Math.round(width * dpr)
    const pixelHeight = Math.round(height * dpr)
    if (viewport?.width === width && viewport.height === height && viewport.copyBottom === copyBottom
      && viewport.pixelWidth === pixelWidth && viewport.pixelHeight === pixelHeight) {
      return
    }

    viewport = { width, height, copyBottom, pixelWidth, pixelHeight }
    resizePending = true
    scheduleRender()
  }

  const observer = new ResizeObserver(resizeCanvas)
  observer.observe(canvas)
  observer.observe(copy)
  resizeCanvas()

  async function load(index, controller) {
    const timeout = window.setTimeout(() => {
      failed.add(index)
      controller.abort()
    }, 8000)

    try {
      const response = await fetch(frameUrl(index), { signal: controller.signal })
      if (!response.ok) throw new Error(`Frame request failed (${response.status})`)
      const bitmap = await createImageBitmap(await response.blob(), decodeOptions)
      if (disposed || controller.signal.aborted) {
        bitmap.close()
        return
      }

      cache.set(index, bitmap)
      trimCache()
    } catch {
      if (!controller.signal.aborted) failed.add(index)
    } finally {
      window.clearTimeout(timeout)
      pending.delete(index)
      if (!disposed) scheduleRender()
    }
  }

  function framePriorities() {
    if (reducedMotion) return [LAST_FRAME, LAST_FRAME - 1, LAST_FRAME - 3, 0]
    const near = [1, 2, 3, 4].map((offset) => target + offset * step * direction)
    const boundary = SCENE_BOUNDARIES.find((cut) =>
      Math.abs(cut - target) <= 24 || Math.abs(cut - destination) <= 36)
    const acrossCut = boundary && (direction > 0
      ? [boundary, boundary + 1, boundary + 2, boundary - 1]
      : [boundary - 1, boundary - 2, boundary - 3, boundary])

    return [target, ...near.slice(0, 2), ...(acrossCut || []), ...near.slice(2),
      target + direction, target - direction, target - 2 * direction,
      destination, destination + direction, destination + 4 * direction,
      target + 7 * step * direction, target + 10 * step * direction]
  }

  function trimCache() {
    if (cache.size <= cacheLimit) return
    // Both the visible bitmap and the active lookahead survive cache eviction.
    let eviction
    for (const index of cache.keys()) {
      if (index === displayed || priorities.has(index)) continue
      const distance = Math.min(Math.abs(index - target), Math.abs(index - destination))
      if (!eviction || distance > eviction.distance) eviction = { index, distance }
    }
    if (eviction) {
      cache.get(eviction.index).close()
      cache.delete(eviction.index)
    }
  }

  function preload() {
    if (reducedMotion && displayed !== undefined) return
    priorities = new Set(framePriorities().filter((index) => index >= 0 && index <= LAST_FRAME))
    for (const [index, controller] of pending) {
      if (!priorities.has(index) && Math.abs(index - target) > 10 && Math.abs(index - destination) > 8) {
        controller.abort()
      }
    }
    for (const index of priorities) {
      if (pending.size >= (reducedMotion ? 1 : MAX_REQUESTS)) break
      if (cache.has(index) || pending.has(index) || failed.has(index)) continue
      const controller = new AbortController()
      pending.set(index, controller)
      void load(index, controller)
    }
    if (displayed === undefined && pending.size === 0) status.textContent = 'Cake preview unavailable'
  }

  function render() {
    gsap.ticker.remove(render)
    scheduled = false
    if (resizePending) {
      const { width, height, pixelWidth, pixelHeight } = viewport
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth
        canvas.height = pixelHeight
      }
      layout = undefined
      context.setTransform(pixelWidth / width, 0, 0, pixelHeight / height, 0, 0)
    }
    draw(resizePending)
    resizePending = false
    preload()
  }

  function scheduleRender() {
    if (scheduled) return
    scheduled = true
    // Coalesce seek, decode and resize updates onto the shared GSAP RAF.
    gsap.ticker.add(render)
  }

  scheduleRender()

  return {
    seek(index) {
      if (target === index) return
      step = Math.min(4, Math.abs(index - target))
      target = index
      scheduleRender()
    },
    anticipate(index, scrollDirection) {
      if (destination === index && direction === scrollDirection) return
      destination = index
      direction = scrollDirection
      scheduleRender()
    },
    destroy() {
      disposed = true
      gsap.ticker.remove(render)
      observer.disconnect()
      for (const controller of pending.values()) controller.abort()
      for (const bitmap of cache.values()) bitmap.close()
      cache.clear()
    },
  }
}

const FRAME_START = 0.075
const FRAME_DURATION = 0.815
const COPY_CHANGES = [
  0.11,
  ...SCENE_BOUNDARIES.map((index) => FRAME_START + FRAME_DURATION * index / LAST_FRAME),
  0.92,
]

export default function Hero() {
  const sectionRef = useRef(null)
  const canvasRef = useRef(null)
  const copyRef = useRef(null)
  const statusRef = useRef(null)

  useLayoutEffect(() => {
    const section = sectionRef.current
    const panels = [...section.querySelectorAll('.cinematic-hero__panel')]
    const indicator = section.querySelector('.cinematic-hero__scroll')
    const media = gsap.matchMedia()

    media.add({
      motion: '(prefers-reduced-motion: no-preference)',
      reduced: '(prefers-reduced-motion: reduce)',
    }, ({ conditions }) => {
      const player = createFramePlayer(canvasRef.current, copyRef.current, statusRef.current, conditions.reduced)
      if (conditions.reduced) return () => player?.destroy()

      const playhead = { frame: 0 }
      const timeline = gsap.timeline({
        defaults: { ease: 'none' },
        scrollTrigger: {
          trigger: section,
          start: 'top top',
          end: () => `+=${Math.round(section.offsetHeight * (section.clientWidth < 768 ? 4 : 6))}`,
          pin: true,
          scrub: 0.8,
          onUpdate: ({ progress, direction }) => {
            const frameProgress = gsap.utils.clamp(0, 1, (progress - FRAME_START) / FRAME_DURATION)
            player?.anticipate(Math.round(frameProgress * LAST_FRAME), direction)
          },
        },
      })

      gsap.set(panels.slice(1), { autoAlpha: 0, y: 10 })
      timeline.to(playhead, {
        frame: LAST_FRAME,
        duration: FRAME_DURATION,
        onUpdate: () => player?.seek(Math.round(playhead.frame)),
      }, FRAME_START)

      COPY_CHANGES.forEach((time, index) => {
        timeline.to(panels[index], { autoAlpha: 0, y: -7, duration: 0.034, ease: 'power1.in' }, time - 0.034)
        timeline.to(panels[index + 1], { autoAlpha: 1, y: 0, duration: 0.044, ease: 'power2.out' }, time)
      })
      timeline.to(indicator, { autoAlpha: 0, y: 8, duration: 0.035 }, 0.045)
      // Hold the completed cake and CTA before releasing the pin.
      timeline.set(playhead, { frame: LAST_FRAME }, 1)

      return () => player?.destroy()
    })

    return () => media.revert()
  }, [])

  return (
    <section ref={sectionRef} className="cinematic-hero" aria-labelledby="hero-title">
      <canvas ref={canvasRef} className="cinematic-hero__canvas" role="img"
        aria-label="A berry-topped layer cake being assembled"
      />
      <span ref={statusRef} className="cinematic-hero__status" role="status">
        Loading the cake sequence
      </span>
      <div ref={copyRef} className="cinematic-hero__copy">
        <div className="cinematic-hero__panel cinematic-hero__opening">
          <p className="cinematic-hero__brand">MRA Restaurant &amp; Bakery</p>
          <h1 id="hero-title" className="cinematic-hero__headline">
            <span>Every Layer.</span>{' '}<em>A Little Magic.</em>
          </h1>
        </div>
        <div className="cinematic-hero__panel cinematic-hero__chapter">
          <p className="cinematic-hero__headline">Made from the finest.</p>
        </div>
        <div className="cinematic-hero__panel cinematic-hero__chapter">
          <p className="cinematic-hero__headline">Layered with love.</p>
        </div>
        <div className="cinematic-hero__panel cinematic-hero__chapter">
          <p className="cinematic-hero__headline">Crafted to Perfection.</p>
        </div>
        <div className="cinematic-hero__panel cinematic-hero__final">
          <p className="cinematic-hero__headline">
            Every celebration deserves something extraordinary.
          </p>
          <a className="cinematic-hero__cta" href="#collection">
            Explore Collection <ArrowUpRight size={15} aria-hidden="true" />
          </a>
        </div>
      </div>
      <div className="cinematic-hero__scroll" aria-hidden="true">
        <ArrowDown size={15} strokeWidth={1.4} />
        <span>Scroll to discover</span>
      </div>
    </section>
  )
}
