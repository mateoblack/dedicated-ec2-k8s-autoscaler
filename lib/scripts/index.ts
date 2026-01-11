/**
 * Script generation modules.
 * These functions generate inline code for CDK Lambda functions and EC2 bootstrap scripts.
 */

// Lambda code generators
export { createEtcdLifecycleLambdaCode } from './etcd-lifecycle-lambda';
export { createEtcdBackupLambdaCode } from './etcd-backup-lambda';
export { createClusterHealthLambdaCode } from './cluster-health-lambda';

// Bootstrap script generators
export { createWorkerBootstrapScript } from './worker-bootstrap';
export { createControlPlaneBootstrapScript } from './control-plane-bootstrap';
