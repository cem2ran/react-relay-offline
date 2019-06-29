import Cache, { CacheOptions } from "@wora/cache-persist";
import { v4 as uuid } from "uuid";
import { Disposable, Network, } from 'relay-runtime/lib/RelayStoreTypes';
import RelayModernEnvironment from './RelayModernEnvironment';
import { ROOT_TYPE } from 'relay-runtime/lib/RelayStoreUtils';
import * as RelayInMemoryRecordSource from 'relay-runtime/lib/RelayInMemoryRecordSource';
import * as RelayModernRecord from 'relay-runtime/lib/RelayModernRecord';
import * as RelayResponseNormalizer from 'relay-runtime/lib/RelayResponseNormalizer';
import { GetDataID } from 'relay-runtime/lib/RelayResponseNormalizer';
import * as ErrorUtils from 'fbjs/lib/ErrorUtils';
import * as RelayRecordSourceMutator from 'relay-runtime/lib/RelayRecordSourceMutator';
import * as RelayRecordSourceProxy from 'relay-runtime/lib/RelayRecordSourceProxy';
import * as RelayReader from 'relay-runtime/lib/RelayReader';
import * as normalizeRelayPayload from 'relay-runtime/lib/normalizeRelayPayload';
import { GraphQLResponseWithData } from 'relay-runtime/lib/RelayNetworkTypes';
import {
    NormalizationSelector,
    RelayResponsePayload
} from 'relay-runtime/lib/RelayStoreTypes';

import { Observable as RelayObservable } from 'relay-runtime';


type Subscription = {
    callback: (state) => void,
};

export type OfflineOptions = {
    manualExecution?: boolean;
    network?: Network;
    onComplete?: (options: { id: string, offlinePayload: any, snapshot: any }) => boolean;
    onDiscard?: (options: { id: string, offlinePayload: any, error: any }) => boolean;
    //onDispatch?: (request: any) => any;
}

class RelayStoreOffline {

    private _cache: Cache;
    private _subscriptions: Set<Subscription> = new Set();
    private _busy: boolean = false;
    private _environment: any;
    private _offlineOptions: OfflineOptions;

    constructor(environment: RelayModernEnvironment, persistOptions: CacheOptions = {}, offlineOptions?: OfflineOptions, ) {

        const persistOptionsStoreOffline = {
            prefix: 'relay-offline',
            serialize: true,
            ...persistOptions,
        };

        const cache = new Cache(persistOptionsStoreOffline);
        this._cache = cache;
        this._environment = environment;
        this._offlineOptions = {
            network: this._environment._network,
            onComplete: (options: any) => { return true },
            onDiscard: (options: any) => { return true },
            //onDispatch: (request: any) => undefined,
        }
        if (offlineOptions) {
            this._offlineOptions = {
                ...this._offlineOptions,
                ...offlineOptions
            }

        }

    }

    public purge(): Promise<boolean> {
        return this._cache.purge().then(purged => {
            this.notify();
            return purged;
        });
    }

    public restore(): Promise<Cache> {
        return this._cache.restore().then(cache => {
            this.notify();
            return cache;
        });
    }

    public subscribe(
        callback: (state) => void,
    ): Disposable {
        const subscription = { callback };
        const dispose = () => {
            this._subscriptions.delete(subscription);
        };
        this._subscriptions.add(subscription);
        return dispose;
    }

    public notify(): void {
        this._subscriptions.forEach(subscription => {
            subscription.callback(this._cache.getState());
        });
    }

    public getListMutation(): ReadonlyArray<any> {
        const requests = Object.assign({}, this._cache.getState());
        return Object.entries(requests).sort(([, v1], [, v2]) => v1.fetchTime - v2.fetchTime).map(item => { return { id: item[0], payload: requests[item[0]] } });
    }


    public execute() {

        if (!this._busy) {
            this._busy = true;
            const requestOrderer: ReadonlyArray<any> = this.getListMutation();
            for (const request of requestOrderer) {
                this.executeMutation(request.id, request.payload)
            }
            this._busy = false;


        }
    }

    async discardMutation(id, payload) {
        const { request } = payload;
        const backup = request.backup;
        await this._cache.remove(id);
        this._environment.getStore().publish(backup);
        this._environment.getStore().notify();
    }

    async executeMutation(id, payload) {
        const { network, onComplete, onDiscard } = this._offlineOptions;
        const { request } = payload;
        const operation = request.operation;
        const uploadables = request.uploadables;
        const source = network.execute(
            operation.node.params,
            operation.variables,
            { force: true },
            uploadables,
        ).subscribe({
            complete: () => {
                const snapshot = this._environment.lookup(operation.fragment, operation);
                if (onComplete({ id, offlinePayload: payload, snapshot: (snapshot.data as any) })) {
                    this._cache.remove(id);
                }
            },
            error: (error, isUncaughtThrownError?: boolean) => {
                if (onDiscard({ id, offlinePayload: payload, error }))
                    this.discardMutation(id, payload);
            },
            /*next: response => {
                if (this._callback) {
                    this._callback("next", response, null);
                }
            },
            start: subscription => this._callback(
                'start',
                subscription,
                null,
            ),*/
        });
        /*const source = environment.executeMutationOffline({
                operation,
                optimisticResponse,
                uploadables,
              }
        ).subscribe({
            
            
            
          });*/
        return source;
    }

    publish(environment, mutationOptions) {
        return RelayObservable.create(sink => {
            const {
                operation,
                optimisticResponse,
                optimisticUpdater,
                updater,
                uploadables,
            } = mutationOptions;


            const backup = new RelayInMemoryRecordSource();
            let sinkPublish = new RelayInMemoryRecordSource()
            if (optimisticResponse || optimisticUpdater) {
                const sink = new RelayInMemoryRecordSource();
                const mutator = new RelayRecordSourceMutator(
                    environment.getStore().getSource(),
                    sink,
                    backup
                );
                const store = new RelayRecordSourceProxy(mutator, environment._getDataID);
                const response = optimisticResponse || null;
                const selectorStoreUpdater = optimisticUpdater;
                const selectorStore = store.commitPayload(operation, response);
                // TODO: Fix commitPayload so we don't have to run normalize twice
                let selectorData, source;
                if (response) {
                    ({ source } = normalizeRelayPayload(
                        operation.root,
                        response,
                        null,
                        { getDataID: environment._getDataID },
                    ));
                    selectorData = RelayReader.read(source, operation.fragment, operation).data;
                }
                selectorStoreUpdater &&
                    ErrorUtils.applyWithGuard(
                        selectorStoreUpdater,
                        null,
                        [selectorStore, selectorData],
                        null,
                        'RelayPublishQueue:applyUpdates',
                    );
            }
            if (optimisticResponse) {
                var payload = normalizeResponse({ data: optimisticResponse },
                    operation.root,
                    ROOT_TYPE,
                    [],
                    environment._getDataID,
                );
                const { fieldPayloads, source } = payload;
                // updater only for configs
                sinkPublish = environment._publishQueue._getSourceFromPayload({ fieldPayloads, operation, source, updater });
                //environment._publishQueue.commitPayload(operation, payload, configs ? updater : null);
                //environment._publishQueue.run();


            }
            /*
            //environment.
            //environment.applyUpdate(optimisticUpdate);*/

            if (!optimisticResponse && optimisticUpdater) {
                const mutator = new RelayRecordSourceMutator(
                    environment.getStore().getSource(),
                    sinkPublish,
                );
                const store = new RelayRecordSourceProxy(mutator, environment._getDataID);
                ErrorUtils.applyWithGuard(
                    optimisticUpdater,
                    null,
                    [store],
                    null,
                    'RelayPublishQueue:commitUpdaters',
                );
                /*    
                if (optimisticUpdater != null) {
                    optimisticUpdater(environment.getStore());
                }
                if (updater) {
                    updater(environment.getStore())
                }*/
            }

            


            //const { onDispatch } = this._offlineOptions;
            const fetchTime = Date.now();
            const id = uuid();
            const request = {
                operation,
                optimisticResponse,
                uploadables,
                backup,
                sinkPublish
            };
            this._cache.set(id, { request, fetchTime }).then(() => {
                environment.getStore().publish(sinkPublish);
                environment.getStore().notify();
                this.notify();
                sink.next({
                    id,
                    request,
                    fetchTime
                });
                sink.complete();
            }).catch(error => {
                sink.error(error, true)
            });
        });
    }

}


function normalizeResponse(
    response: GraphQLResponseWithData,
    selector: NormalizationSelector,
    typeName: string,
    path: ReadonlyArray<string>,
    getDataID: GetDataID,
): RelayResponsePayload {
    const { data, errors } = response;
    const source = new RelayInMemoryRecordSource();
    const record = RelayModernRecord.create(selector.dataID, typeName);
    source.set(selector.dataID, record);
    const normalizeResult = RelayResponseNormalizer.normalize(
        source,
        selector,
        data,
        { handleStrippedNulls: true, path, getDataID },
    );
    return {
        errors,
        incrementalPlaceholders: normalizeResult.incrementalPlaceholders,
        fieldPayloads: normalizeResult.fieldPayloads,
        moduleImportPayloads: normalizeResult.moduleImportPayloads,
        source,
    };
}

export default RelayStoreOffline;