# Control Nodes Updates 

Updates are controlled through SSM. The following shows you have to change the `kubelet` version with version `1.29.0`

## How To Update 

1. 1. Update SSM parameter: `aws ssm put-parameter --name "/my-cluster/control/kubelet/version" --value "1.29.0" --overwrite`
2. Run `cdk deploy` → Rolling replacement happens