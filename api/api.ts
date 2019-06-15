import { clientApi, RingRestClient } from './rest-client'
import { Location } from './location'
import {
  ActiveDing,
  BaseStation,
  BeamBridge,
  CameraData,
  HistoricalDingGlobal,
  UserLocation
} from './ring-types'
import { RingCamera } from './ring-camera'
import { EMPTY, merge, Subject } from 'rxjs'
import { debounceTime, switchMap, throttleTime } from 'rxjs/operators'

export interface RingAlarmOptions {
  email: string
  password: string
  locationIds?: string[]
  cameraStatusPollingSeconds?: number
  cameraDingsPollingSeconds?: number
}

export class RingApi {
  public readonly restClient = new RingRestClient(
    this.options.email,
    this.options.password
  )

  private locations = this.fetchAndBuildLocations()

  constructor(public readonly options: RingAlarmOptions) {}

  async fetchRingDevices() {
    const {
      doorbots,
      stickup_cams: stickupCams,
      base_stations: baseStations,
      beams_bridges: beamBridges
    } = await this.restClient.request<{
      doorbots: CameraData[]
      stickup_cams: CameraData[]
      base_stations: BaseStation[]
      beams_bridges: BeamBridge[]
    }>({ url: clientApi('ring_devices') })

    return {
      doorbots,
      stickupCams,
      allCameras: doorbots.concat(stickupCams),
      baseStations,
      beamBridges
    }
  }

  fetchActiveDings() {
    return this.restClient.request<ActiveDing[]>({
      url: clientApi('dings/active?burst=false ')
    })
  }

  private listenForCameraUpdates(cameras: RingCamera[]) {
    const {
        cameraStatusPollingSeconds,
        cameraDingsPollingSeconds
      } = this.options,
      camerasRequestUpdate$ = merge(
        ...cameras.map(camera => camera.onRequestUpdate)
      ).pipe(throttleTime(500)),
      updateReceived$ = new Subject(),
      pollForStatusUpdate$ = cameraStatusPollingSeconds
        ? updateReceived$.pipe(debounceTime(cameraStatusPollingSeconds * 1000))
        : EMPTY

    if (!cameras.length) {
      return
    }

    merge(camerasRequestUpdate$, pollForStatusUpdate$)
      .pipe(
        throttleTime(500),
        switchMap(async () => {
          const response = await this.fetchRingDevices().catch(() => null)
          return response && response.allCameras
        })
      )
      .subscribe(cameraData => {
        updateReceived$.next()

        if (!cameraData) {
          return
        }

        cameraData.forEach(data => {
          const camera = cameras.find(x => x.id === data.id)
          if (camera) {
            camera.updateData(data)
          }
        })
      })

    if (cameraStatusPollingSeconds) {
      updateReceived$.next() // kick off polling
    }

    if (cameraDingsPollingSeconds) {
      const poolForActiveDings$ = new Subject()

      poolForActiveDings$
        .pipe(
          debounceTime(cameraDingsPollingSeconds * 1000),
          switchMap(() => {
            return this.fetchActiveDings().catch(() => null)
          })
        )
        .subscribe(activeDings => {
          poolForActiveDings$.next()

          if (!activeDings || !activeDings.length) {
            return
          }

          cameras.forEach(camera =>
            camera.processActiveDings(
              activeDings.filter(ding => ding.doorbot_id === camera.id)
            )
          )
        })

      poolForActiveDings$.next() // kick off pooling
    }
  }

  async fetchRawLocations() {
    const { user_locations: rawLocations } = await this.restClient.request<{
      user_locations: UserLocation[]
    }>({ url: 'https://app.ring.com/rhq/v1/devices/v1/locations' })

    return rawLocations
  }

  async fetchAndBuildLocations() {
    const rawLocations = await this.fetchRawLocations(),
      {
        doorbots,
        stickupCams,
        baseStations,
        beamBridges
      } = await this.fetchRingDevices(),
      locationIdsWithHubs = [...baseStations, ...beamBridges].map(
        x => x.location_id
      ),
      cameras = doorbots
        .concat(stickupCams)
        .map(
          data => new RingCamera(data, doorbots.includes(data), this.restClient)
        ),
      locations = rawLocations
        .filter(location => {
          return (
            !Array.isArray(this.options.locationIds) ||
            this.options.locationIds.includes(location.location_id)
          )
        })
        .map(
          location =>
            new Location(
              location,
              cameras.filter(x => x.data.location_id === location.location_id),
              locationIdsWithHubs.includes(location.location_id),
              this.restClient
            )
        )

    this.listenForCameraUpdates(cameras)

    return locations
  }

  getLocations() {
    return this.locations
  }

  async getCameras() {
    const locations = await this.locations
    return locations.reduce(
      (cameras, location) => [...cameras, ...location.cameras],
      [] as RingCamera[]
    )
  }

  getHistory(limit = 10, favoritesOnly = false) {
    const favoritesParam = favoritesOnly ? '&favorites=1' : ''
    return this.restClient.request<HistoricalDingGlobal[]>({
      url: clientApi(`doorbots/history?limit=${limit}${favoritesParam}`)
    })
  }
}