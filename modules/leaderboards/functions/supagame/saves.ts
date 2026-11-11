import { ApiFailure } from './responses.ts';
import { body, object, UUID } from './validation.ts';
import type { Json, RpcCall } from './types.ts';

export async function saveCall(request: Request, slot: string): Promise<RpcCall> {
  if (request.method === 'GET') {
    return {
      name: 'sg_cloud_save',
      args: { p_action: slot ? 'load' : 'list', p_slot: slot || null, p_request: {} },
    };
  }
  if (slot === '~cleanup') {
    return { name: 'sg_cloud_save', args: { p_action: 'cleanup', p_slot: null, p_request: {} } };
  }
  const value = await body(request, 2 * 1024 * 1024, false);
  const fields: Record<string, string[]> = {
    save: ['action', 'expectedRevision', 'operationId', 'schemaVersion', 'metadata', 'data'],
    delete: ['action', 'expectedRevision', 'operationId'],
    prepare: [
      'action',
      'expectedRevision',
      'operationId',
      'schemaVersion',
      'metadata',
      'sizeBytes',
      'checksum',
    ],
    commit: ['action', 'operationId'],
    abort: ['action', 'operationId'],
    revisions: ['action'],
    loadRevision: ['action', 'revision'],
    restore: ['action', 'revision', 'expectedRevision', 'operationId'],
  };
  const action = value.action;
  let expected = typeof action === 'string' && Object.hasOwn(fields, action)
    ? fields[action]
    : undefined;
  if (
    expected && ['save', 'delete', 'prepare'].includes(String(action)) &&
    Object.hasOwn(value, 'backupExisting')
  ) {
    if (typeof value.backupExisting !== 'boolean') throw new ApiFailure('INVALID_SAVE');
    expected = [...expected, 'backupExisting'];
  }
  if (
    !expected || Object.keys(value).length !== expected.length ||
    !expected.every((key) => Object.hasOwn(value, key)) ||
    (expected.includes('operationId') &&
      (typeof value.operationId !== 'string' || !UUID.test(value.operationId)))
  ) throw new ApiFailure('INVALID_SAVE');
  for (const key of ['expectedRevision', 'schemaVersion', 'sizeBytes', 'revision']) {
    if (
      Object.hasOwn(value, key) &&
      (typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) ||
        value[key] < (key === 'expectedRevision' ? 0 : 1))
    ) throw new ApiFailure('INVALID_SAVE');
  }
  if (Object.hasOwn(value, 'metadata') && !object(value.metadata)) {
    throw new ApiFailure('INVALID_SAVE');
  }
  const payload = { ...value };
  delete payload.action;
  return {
    name: 'sg_cloud_save',
    args: { p_action: action as string, p_slot: slot, p_request: payload as Json },
  };
}
