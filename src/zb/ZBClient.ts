import chalk from 'chalk'
import * as fs from 'fs'
import * as GRPCClient from 'node-grpc-client'
import * as path from 'path'
import { BpmnParser, stringifyVariables } from '../lib'
import * as ZB from '../lib/interfaces'
import { ZBWorker } from './ZBWorker'

const idColors = [
	chalk.yellow,
	chalk.green,
	chalk.cyan,
	chalk.magenta,
	chalk.blue,
]

export class ZBClient {
	public brokerAddress: string
	private closePromise?: Promise<any>
	private closing = false
	private gRPCClient: any
	private options: ZB.ZBClientOptions
	private workerCount = 0
	private workers: ZBWorker[] = []

	constructor(brokerAddress: string, options: ZB.ZBClientOptions = {}) {
		if (!brokerAddress) {
			throw new Error(
				'Must provide a broker address string to constructor'
			)
		}
		this.options = options || {}
		this.options.loglevel =
			(process.env.ZB_NODE_LOG_LEVEL as ZB.Loglevel) ||
			options.loglevel ||
			'INFO'

		if (brokerAddress.indexOf(':') === -1) {
			brokerAddress += ':26500'
		}

		this.brokerAddress = brokerAddress

		this.gRPCClient = new GRPCClient(
			path.join(__dirname, '../../proto/zeebe.proto'),
			'gateway_protocol',
			'Gateway',
			brokerAddress
		)
	}

	/**
	 *
	 * @param id - A unique identifier for this worker.
	 * @param taskType - The BPMN Zeebe task type that this worker services.
	 * @param taskHandler - A handler for activated jobs.
	 * @param options - Configuration options for the worker.
	 */
	public createWorker(
		id: string,
		taskType: string,
		taskHandler: ZB.ZBWorkerTaskHandler,
		options: ZB.ZBWorkerOptions & ZB.ZBClientOptions = {},
		onConnectionError?: ZB.ConnectionErrorHandler | undefined
	) {
		if (this.closing) {
			throw new Error('Client is closing. No worker creation allowed!')
		}
		const idColor = idColors[this.workerCount++ % idColors.length]
		const worker = new ZBWorker({
			gRPCClient: this.gRPCClient,
			id,
			idColor,
			onConnectionError,
			options: { ...this.options, ...options },
			taskHandler,
			taskType,
			zbClient: this,
		})
		this.workers.push(worker)
		return worker
	}

	/**
	 * Gracefully shut down all workers, draining existing tasks, and return when it is safe to exit.
	 * @returns Promise
	 * @memberof ZBClient
	 */
	public close() {
		if (this.closePromise) {
			return this.closePromise
		}
		// Prevent the creation of more workers
		this.closing = true
		this.closePromise = Promise.all(this.workers.map(w => w.close()))
		return this.closePromise
	}

	/**
	 * Return the broker cluster topology
	 */
	public topology(): Promise<ZB.TopologyResponse> {
		return this.gRPCClient.topologySync()
	}

	/**
	 *
	 * @param workflow - A path or array of paths to .bpmn files.
	 * @param {redeploy?: boolean} - Redeploy workflow. Defaults to true.
	 * If set false, will not redeploy a workflow that exists.
	 */
	public async deployWorkflow(
		workflow: string | string[],
		{ redeploy = true } = {}
	): Promise<ZB.DeployWorkflowResponse> {
		const workflows = Array.isArray(workflow) ? workflow : [workflow]
		let deployedWorkflows: any[] = []
		if (!redeploy) {
			deployedWorkflows = (await this.listWorkflows()).workflows.map(
				(wf: any) => wf.bpmnProcessId
			)
		}
		const workFlowRequests: ZB.WorkflowRequestObject[] = workflows
			.map(wf => ({
				definition: fs.readFileSync(wf),
				name: path.basename(wf),
				type: 1,
			}))
			.filter(
				wfr =>
					!deployedWorkflows.includes(
						BpmnParser.getProcessId(wfr.definition.toString())
					)
			)
		if (workFlowRequests.length > 0) {
			return this.gRPCClient.deployWorkflowSync({
				workflows: workFlowRequests,
			})
		} else {
			return {
				key: -1,
				workflows: [],
			}
		}
	}

	/**
	 * Return an array of task-types specified in a BPMN file.
	 * @param file - Path to bpmn file.
	 */
	public getServiceTypesFromBpmn(files: string | string[]) {
		if (typeof files === 'string') {
			files = [files]
		}
		return BpmnParser.getTaskTypes(BpmnParser.parseBpmn(files))
	}

	/**
	 * Publish a message to the broker for correlation with a workflow instance.
	 * @param publishMessageRequest - The message to publish.
	 */
	public publishMessage(
		publishMessageRequest: ZB.PublishMessageRequest
	): Promise<void> {
		return this.gRPCClient.publishMessageSync(
			stringifyVariables(publishMessageRequest)
		)
	}

	/**
	 * Publish a message to the broker for correlation with a workflow message start event.
	 * @param publishStartMessageRequest - The message to publish.
	 */
	public publishStartMessage(
		publishStartMessageRequest: ZB.PublishStartMessageRequest
	): Promise<void> {
		const publishMessageRequest: ZB.PublishMessageRequest = {
			correlationKey: '__MESSAGE_START_EVENT__',
			...publishStartMessageRequest,
		}
		return this.gRPCClient.publishMessageSync(
			stringifyVariables(publishMessageRequest)
		)
	}

	public updateJobRetries(
		updateJobRetriesRequest: ZB.UpdateJobRetriesRequest
	): Promise<void> {
		return this.gRPCClient.updateJobRetriesSync(updateJobRetriesRequest)
	}

	public failJob(failJobRequest: ZB.FailJobRequest): Promise<void> {
		return this.gRPCClient.failJobSync(failJobRequest)
	}

	/**
	 *
	 * Create and start execution of a workflow instance.
	 * @param {string} bpmnProcessId
	 * @param {Variables} variables - payload to pass in to the workflow
	 * @param {number} [version] - version of the workflow to run. Optional: defaults to latest if not present
	 * @returns {Promise<CreateWorkflowInstanceResponse>}
	 * @memberof ZBClient
	 */
	public createWorkflowInstance(
		bpmnProcessId: string,
		variables: ZB.Variables,
		version?: number
	): Promise<ZB.CreateWorkflowInstanceResponse> {
		version = version || -1

		const createWorkflowInstanceRequest: ZB.CreateWorkflowInstanceRequest = {
			bpmnProcessId,
			variables,
			version,
		}
		return this.gRPCClient.createWorkflowInstanceSync(
			stringifyVariables(createWorkflowInstanceRequest)
		)
	}

	public async cancelWorkflowInstance(
		workflowInstanceKey: string
	): Promise<void> {
		return this.gRPCClient.cancelWorkflowInstanceSync({
			workflowInstanceKey,
		})
	}

	public setVariables(request: ZB.SetVariablesRequest): Promise<void> {
		/*
		We allow developers to interact with variables as a native JS object, but the Zeebe server needs it as a JSON document
		So we stringify it here.
		*/
		if (typeof request.variables === 'object') {
			request.variables = JSON.stringify(request.variables) as any
		}
		return this.gRPCClient.setVariablesSync(request)
	}

	public listWorkflows(
		bpmnProcessId?: string
	): Promise<ZB.ListWorkflowResponse> {
		return this.gRPCClient.listWorkflowsSync({ bpmnProcessId })
	}

	public getWorkflow(
		getWorkflowRequest: ZB.GetWorkflowRequest
	): Promise<ZB.GetWorkflowResponse> {
		if (this.hasBpmnProcessId(getWorkflowRequest)) {
			getWorkflowRequest.version = getWorkflowRequest.version || -1
		}
		return this.gRPCClient.getWorkflowSync(getWorkflowRequest)
	}

	public resolveIncident(incidentKey: string): Promise<void> {
		return this.gRPCClient.resolveIncidentSync(incidentKey)
	}

	private hasBpmnProcessId(
		request: ZB.GetWorkflowRequest
	): request is ZB.GetWorkflowRequestWithBpmnProcessId {
		return (
			(request as ZB.GetWorkflowRequestWithBpmnProcessId)
				.bpmnProcessId !== undefined
		)
	}
}
