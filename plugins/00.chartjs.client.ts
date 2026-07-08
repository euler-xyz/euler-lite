import annotationPlugin from 'chartjs-plugin-annotation'
import { Chart as ChartJS } from 'chart.js'

export default defineNuxtPlugin(() => {
  ChartJS.register(annotationPlugin)
})
