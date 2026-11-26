import { useEffect } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import Lenis from 'lenis'
import 'lenis/dist/lenis.css'
import Hero from './components/sections/Hero'

export default function App() {
  useEffect(() => {
    const media = gsap.matchMedia()
    media.add('(prefers-reduced-motion: no-preference)', () => {
      const lenis = new Lenis({
        lerp: 0.09,
        autoRaf: false,
        syncTouch: false,
        anchors: true,
      })
      const updateScrollTrigger = () => ScrollTrigger.update()
      const tick = (seconds) => lenis.raf(seconds * 1000)

      lenis.on('scroll', updateScrollTrigger)
      gsap.ticker.add(tick, false, true)
      return () => {
        gsap.ticker.remove(tick)
        lenis.off('scroll', updateScrollTrigger)
        lenis.destroy()
      }
    })
    return () => media.revert()
  }, [])

  return (
    <main className="overflow-x-clip">
      <Hero />
      <section
        id="collection"
        aria-labelledby="collection-title"
        className="grid min-h-svh place-items-center bg-ivory px-6 text-primary"
      >
        <h2 id="collection-title" className="text-center font-heading text-5xl sm:text-7xl">
          The Collection
        </h2>
      </section>
    </main>
  )
}
