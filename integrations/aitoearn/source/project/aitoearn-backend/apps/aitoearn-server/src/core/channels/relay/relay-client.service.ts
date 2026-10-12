import type { AssetsConfig } from '@yikart/assets'
import { basename } from 'node:path'
import { Injectable, Logger } from '@nestjs/common'
import { AppException, CommonResponse, officeRelayCredentials, ResponseCode } from '@yikart/common'
import { AssetType } from '@yikart/mongodb'
import axios, { AxiosRequestConfig } from 'axios'
import { config } from '../../../config'

interface UploadSignResult {
  id: string
  path: string
  url: string
  uploadUrl: string
}

@Injectable()
export class RelayClientService {
  private readonly logger = new Logger(RelayClientService.name)

  get enabled() {
    return !!config.relay && (!!config.officeBridge || !!config.relay.apiKey)
  }

  async getConfiguration() {
    if (!config.relay) throw new AppException(ResponseCode.RelayServerUnavailable)
    try {
      return config.officeBridge ? { ...config.relay, ...await officeRelayCredentials(config.officeBridge) } : config.relay
    }
    catch { throw new AppException(ResponseCode.RelayServerUnavailable) }
  }

  async get<T>(path: string, params?: Record<string, any>): Promise<T> {
    return this.request<T>({ method: 'GET', url: path, params })
  }

  async post<T>(path: string, data?: unknown): Promise<T> {
    return this.request<T>({ method: 'POST', url: path, data })
  }

  async patch<T>(path: string, data?: unknown): Promise<T> {
    return this.request<T>({ method: 'PATCH', url: path, data })
  }

  async delete<T>(path: string, data?: unknown): Promise<T> {
    return this.request<T>({ method: 'DELETE', url: path, data })
  }

  async uploadFileFromLocalUrl(localUrl: string): Promise<string> {
    const filename = basename(new URL(localUrl).pathname)

    const fileResponse = await axios.get(localUrl, { responseType: 'arraybuffer' })
    const contentType = fileResponse.headers['content-type'] || 'application/octet-stream'
    const size = (fileResponse.data as ArrayBuffer).byteLength

    const signResult = await this.post<UploadSignResult>('/assets/uploadSign', {
      filename,
      type: AssetType.PublishMedia,
      size,
    })

    if (!signResult?.uploadUrl) {
      throw new Error('Relay uploadSign returned no uploadUrl')
    }

    await axios.put(signResult.uploadUrl, fileResponse.data, {
      headers: { 'Content-Type': contentType },
    })

    await this.post(`/assets/${signResult.id}/confirm`, {})

    return signResult.url
  }

  async replaceLocalUrls(body: unknown, assetsConfig: AssetsConfig | undefined = config.assets): Promise<unknown> {
    const localUrlPrefixes = [assetsConfig?.endpoint, assetsConfig?.cdnEndpoint]
      .filter((prefix): prefix is string => Boolean(prefix))
      .map(prefix => prefix.replace(/\/+$/, ''))
    if (!body || localUrlPrefixes.length === 0) {
      return body
    }

    let bodyStr = JSON.stringify(body)
    const urlPattern = new RegExp(
      `(${localUrlPrefixes.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})/[^"\\s]+`,
      'g',
    )

    const localUrls = [...new Set(bodyStr.match(urlPattern) || [])]

    for (const localUrl of localUrls) {
      let downloadUrl = localUrl
      const cdnPrefix = assetsConfig?.cdnEndpoint?.replace(/\/+$/, '')
      const endpointPrefix = assetsConfig?.endpoint?.replace(/\/+$/, '')
      if (cdnPrefix && endpointPrefix && localUrl.startsWith(cdnPrefix)) {
        const bucket = assetsConfig?.bucketName || ''
        const internalBase = `${endpointPrefix}${bucket ? `/${bucket}` : ''}`
        downloadUrl = localUrl.replace(cdnPrefix, internalBase)
      }
      const relayUrl = await this.uploadFileFromLocalUrl(downloadUrl)
      bodyStr = bodyStr.replaceAll(localUrl, relayUrl)
    }

    return JSON.parse(bodyStr)
  }

  private async request<T>(options: AxiosRequestConfig): Promise<T> {
    if (!config.relay) {
      throw new AppException(ResponseCode.RelayServerUnavailable)
    }

    try {
      const relay = await this.getConfiguration()
      const response = await axios<CommonResponse<T>>({
        ...options,
        url: `${relay.serverUrl}${options.url}`,
        headers: {
          ...options.headers,
          'x-api-key': relay.apiKey,
        },
      })
      if (response.data.code !== 0) {
        this.logger.error({ message: 'Relay API returned error', code: response.data.code })
        throw new AppException(ResponseCode.RelayServerUnavailable)
      }
      return response.data.data as T
    }
    catch {
      this.logger.error('Relay request failed')
      throw new AppException(ResponseCode.RelayServerUnavailable)
    }
  }
}
