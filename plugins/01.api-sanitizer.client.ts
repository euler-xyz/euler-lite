import axios from 'axios'
import { sanitizeApiResponse } from '~/utils/sanitizeApiResponse'

export default defineNuxtPlugin(() => {
  axios.interceptors.response.use((response) => {
    if (response.config.url?.startsWith('/api/')) {
      response.data = sanitizeApiResponse(response.data)
    }
    return response
  })
})
