import { useI18n } from 'vue-i18n'
import { computed, ref, watch } from 'vue'

import { CoreWorkingDirectory } from '@/constant/kernel'
import { useAppSettingsStore, useEnvStore, useKernelApiStore } from '@/stores'
import {
  getGitHubApiAuthorization,
  GrantTUNPermission,
  ignoredError,
  confirm,
  message,
  debounce,
  getKernelFileName,
  getKernelAssetFileName,
} from '@/utils'

import {
  Download,
  HttpCancel,
  UnzipZIPFile,
  UnzipTarGZFile,
  HttpGet,
  Exec,
  Movefile,
  Removefile,
  AbsolutePath,
  BrowserOpenURL,
  Makedir,
  FileExists,
} from '@/bridge'

const StableUrl = 'https://api.github.com/repos/SagerNet/sing-box/releases/latest'
const AlphaUrl = 'https://api.github.com/repos/SagerNet/sing-box/releases'

const StablePage = 'https://github.com/SagerNet/sing-box/releases/latest'
const AlphaPage = 'https://github.com/SagerNet/sing-box/releases'

export const useCoreBranch = (isAlpha = false) => {
  const releaseUrl = isAlpha ? AlphaUrl : StableUrl

  const localVersion = ref('')
  const remoteVersion = ref('')
  const versionDetail = ref('')

  const localVersionLoading = ref(false)
  const remoteVersionLoading = ref(false)
  const downloading = ref(false)
  const downloadCompleted = ref(false)

  const rollbackable = ref(false)

  const { t } = useI18n()
  const envStore = useEnvStore()
  const appSettings = useAppSettingsStore()
  const kernelApiStore = useKernelApiStore()

  const restartable = computed(() => {
    const { running, branch } = appSettings.app.kernel
    if (!running) return false
    return localVersion.value && downloadCompleted.value && (branch === 'alpha') === isAlpha
  })

  const updatable = computed(
    () => remoteVersion.value && localVersion.value !== remoteVersion.value,
  )

  const grantable = computed(() => localVersion.value && envStore.env.os !== 'windows')

  const CoreFilePath = `${CoreWorkingDirectory}/${getKernelFileName(isAlpha)}`
  const CoreBakFilePath = `${CoreFilePath}.bak`

  const downloadCore = async () => {
    downloading.value = true
    try {
      const { body } = await HttpGet<Record<string, any>>(releaseUrl, {
        Authorization: getGitHubApiAuthorization(),
      })
      if (body.message) throw body.message

      const { assets, name } = isAlpha ? body.find((v: any) => v.prerelease === true) : body
      const assetName = getKernelAssetFileName(name, isAlpha)
      const asset = assets.find((v: any) => v.name === assetName)
      if (!asset) throw 'Asset Not Found:' + assetName
      if (asset.uploader.type !== 'Bot') {
        await confirm('common.warning', 'settings.kernel.risk', {
          type: 'text',
          okText: 'settings.kernel.stillDownload',
        })
      }

      const downloadCacheFile = `data/.cache/${assetName}`
      const downloadCancelId = downloadCacheFile

      const { update, destroy } = message.info('common.downloading', 10 * 60 * 1_000, () => {
        HttpCancel(downloadCancelId)
        setTimeout(() => Removefile(downloadCacheFile), 1000)
      })

      await Makedir(CoreWorkingDirectory)

      await Download(
        asset.browser_download_url,
        downloadCacheFile,
        undefined,
        (progress, total) => {
          update(t('common.downloading') + ((progress / total) * 100).toFixed(2) + '%')
        },
        { CancelId: downloadCancelId },
      ).finally(destroy)

      const stableFileName = getKernelFileName()

      await ignoredError(Movefile, CoreFilePath, CoreBakFilePath)

      if (assetName.endsWith('.zip')) {
        await UnzipZIPFile(downloadCacheFile, 'data/.cache')
        const tmpPath = `data/.cache/${assetName.replace('.zip', '')}`
        await Movefile(`${tmpPath}/${stableFileName}`, CoreFilePath)
        await Removefile(tmpPath)
      } else if (assetName.endsWith('.tar.gz')) {
        await UnzipTarGZFile(downloadCacheFile, 'data/.cache')
        const tmpPath = `data/.cache/${assetName.replace('.tar.gz', '')}`
        await Movefile(`${tmpPath}/${stableFileName}`, CoreFilePath)
        await Removefile(tmpPath)
      }

      await Removefile(downloadCacheFile)

      if (!CoreFilePath.endsWith('.exe')) {
        await ignoredError(Exec, 'chmod', ['+x', await AbsolutePath(CoreFilePath)])
      }

      refreshLocalVersion()
      downloadCompleted.value = true
      message.success('common.success')
    } catch (error: any) {
      console.log(error)
      message.error(error.message || error)
      downloadCompleted.value = false
    }
    downloading.value = false
  }

  const getLocalVersion = async (showTips = false) => {
    localVersionLoading.value = true
    try {
      const res = await Exec(CoreFilePath, ['version'])
      versionDetail.value = res.trim()
      return res.match(/version (\S+)/)?.[1] || ''
    } catch (error: any) {
      console.log(error)
      showTips && message.error(error)
    } finally {
      localVersionLoading.value = false
    }
    return ''
  }

  const getRemoteVersion = async (showTips = false) => {
    remoteVersionLoading.value = true
    try {
      const { body } = await HttpGet<Record<string, any>>(releaseUrl, {
        Authorization: getGitHubApiAuthorization(),
      })
      const asset = isAlpha ? body.find((v: any) => v.prerelease === true) : body
      const { name, tag_name } = asset
      return (name || tag_name).replace('v', '') as string
    } catch (error: any) {
      console.log(error)
      showTips && message.error(error)
    } finally {
      remoteVersionLoading.value = false
    }
    return ''
  }

  const restartCore = async () => {
    if (!appSettings.app.kernel.running) return
    try {
      await kernelApiStore.restartKernel()
      downloadCompleted.value = false
      message.success('common.success')
    } catch (error: any) {
      message.error(error)
    }
  }

  const refreshLocalVersion = async (showTips = false) => {
    localVersion.value = await getLocalVersion(showTips)
  }

  const refreshRemoteVersion = async (showTips = false) => {
    remoteVersion.value = await getRemoteVersion(showTips)
  }

  const grantCorePermission = async () => {
    await GrantTUNPermission(CoreFilePath)
    message.success('common.success')
  }

  const rollbackCore = async () => {
    await confirm('common.warning', 'settings.kernel.rollback')

    const doRollback = () => Movefile(CoreBakFilePath, CoreFilePath)

    const { running, branch } = appSettings.app.kernel
    const isCurrentRunning = running && (branch === 'alpha') === isAlpha
    if (isCurrentRunning) {
      await kernelApiStore.restartKernel(doRollback)
    } else {
      await doRollback()
    }
    refreshLocalVersion()
    message.success('common.success')
  }

  const openReleasePage = () => {
    BrowserOpenURL(isAlpha ? AlphaPage : StablePage)
  }

  watch(
    () => appSettings.app.kernel.branch,
    () => (downloadCompleted.value = false),
  )

  watch(
    [localVersion, downloadCompleted],
    debounce(async () => {
      rollbackable.value = await FileExists(CoreBakFilePath)
    }, 500),
  )

  refreshLocalVersion()
  refreshRemoteVersion()

  return {
    restartable,
    updatable,
    grantable,
    rollbackable,
    versionDetail,
    localVersion,
    localVersionLoading,
    remoteVersion,
    remoteVersionLoading,
    downloading,
    refreshLocalVersion,
    refreshRemoteVersion,
    downloadCore,
    restartCore,
    rollbackCore,
    grantCorePermission,
    openReleasePage,
  }
}
