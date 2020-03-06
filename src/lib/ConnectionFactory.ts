import { GrpcClientCtor } from './GrpcClient'
import { GrpcMiddleware } from './GrpcMiddleware'
import { ZBLoggerConfig } from './interfaces'
import { StatefulLogInterceptor } from './StatefulLogInterceptor'

export type GrpcConnectionProfile = 'CAMUNDA_CLOUD' | 'VANILLA'
export interface Characteristics {
	startupTime: number
	_tag: GrpcConnectionProfile
}

export const ConnectionCharacteristics: {
	[key in GrpcConnectionProfile]: Characteristics
} = {
	CAMUNDA_CLOUD: {
		_tag: 'CAMUNDA_CLOUD',
		startupTime: 5000,
	},
	VANILLA: {
		_tag: 'VANILLA',
		startupTime: 0,
	},
}

export type State = 'ERROR' | 'CONNECTED'

export class ConnectionFactory {
	public static getGrpcClient({
		grpcConfig,
		logConfig,
	}: {
		grpcConfig: GrpcClientCtor
		logConfig: ZBLoggerConfig
	}) {
		const characteristics = ConnectionFactory.getCharacteristics(
			grpcConfig.host
		)
		const log = new StatefulLogInterceptor({ characteristics, logConfig })
		const grpcClient = new GrpcMiddleware({
			characteristics,
			config: grpcConfig,
			log,
		}).getGrpcClient()
		return { grpcClient, log }
	}

	private static getCharacteristics(host: string): Characteristics {
		const isCamundaCloud = host.includes('zeebe.camunda.io')
		const profile = isCamundaCloud ? 'CAMUNDA_CLOUD' : 'VANILLA'
		return ConnectionCharacteristics[profile]
	}
}
