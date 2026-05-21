import { logWarn } from './errorHandling'

let mooolerAudio: HTMLAudioElement | null = null
let mooolerUnlocked = false
let mooolerUnlocking = false
let mooolerUnlockCleanup: (() => void) | null = null

const getMooolerAudio = () => {
  if (typeof window === 'undefined') return null
  if (mooolerAudio) return mooolerAudio
  mooolerAudio = new Audio('/sounds/moooler.wav')
  mooolerAudio.preload = 'auto'
  return mooolerAudio
}

export const prepareMooolerSound = () => {
  const audio = getMooolerAudio()
  if (!audio || mooolerUnlocked || mooolerUnlocking || mooolerUnlockCleanup) return

  const pointerEvent: keyof WindowEventMap = typeof PointerEvent === 'undefined' ? 'touchstart' : 'pointerdown'
  const events: Array<keyof WindowEventMap> = [pointerEvent, 'keydown']

  const removeUnlockListeners = () => {
    for (const ev of events) {
      window.removeEventListener(ev, unlock, { capture: true })
    }
    mooolerUnlockCleanup = null
  }

  const unlock = () => {
    if (!mooolerAudio || mooolerUnlocked || mooolerUnlocking) return
    mooolerUnlocking = true
    removeUnlockListeners()
    const prevVolume = mooolerAudio.volume
    mooolerAudio.volume = 0
    mooolerAudio.play().then(() => {
      mooolerAudio!.pause()
      mooolerAudio!.currentTime = 0
      mooolerAudio!.volume = prevVolume
      mooolerUnlocked = true
    }).catch(() => {
      if (mooolerAudio) mooolerAudio.volume = prevVolume
      mooolerUnlocking = false
    })
  }

  mooolerUnlockCleanup = removeUnlockListeners
  for (const ev of events) {
    window.addEventListener(ev, unlock, { capture: true, passive: true, once: true })
  }
}

export const playMooolerSound = () => {
  const mooolerAudio = getMooolerAudio()
  if (!mooolerAudio) return
  try {
    mooolerAudio.currentTime = 0
    void mooolerAudio.play().catch((err) => {
      logWarn('moooler/play-blocked', err)
    })
  }
  catch (err) {
    logWarn('moooler/play-throw', err)
  }
}
