import { logWarn } from './errorHandling'

let mooolerAudio: HTMLAudioElement | null = null
let mooolerUnlocked = false

if (typeof window !== 'undefined') {
  mooolerAudio = new Audio('/sounds/moooler.wav')
  mooolerAudio.preload = 'auto'

  const unlock = () => {
    if (!mooolerAudio || mooolerUnlocked) return
    const prevVolume = mooolerAudio.volume
    mooolerAudio.volume = 0
    mooolerAudio.play().then(() => {
      mooolerAudio!.pause()
      mooolerAudio!.currentTime = 0
      mooolerAudio!.volume = prevVolume
      mooolerUnlocked = true
    }).catch(() => {
      if (mooolerAudio) mooolerAudio.volume = prevVolume
    })
  }

  const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'touchstart']
  for (const ev of events) {
    window.addEventListener(ev, unlock, { capture: true, passive: true })
  }
}

export const playMooolerSound = () => {
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
