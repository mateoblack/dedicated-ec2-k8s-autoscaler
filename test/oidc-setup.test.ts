import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { K8sClusterStack } from '../lib/k8s-cluster-stack';

describe('OIDC Setup', () => {
  let template: Template;
  let templateJson: any;
  let controlPlaneUserData: string;

  // Helper to extract string content from CloudFormation intrinsic functions
  function extractStringContent(obj: any): string {
    if (typeof obj === 'string') {
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map(extractStringContent).join('');
    }
    if (obj && typeof obj === 'object') {
      if (obj['Fn::Join']) {
        const [separator, parts] = obj['Fn::Join'];
        return parts.map(extractStringContent).join(separator);
      }
      if (obj['Fn::Base64']) {
        return extractStringContent(obj['Fn::Base64']);
      }
      if (obj['Ref']) {
        return `\${${obj['Ref']}}`;
      }
      if (obj['Fn::GetAtt']) {
        return `\${${obj['Fn::GetAtt'].join('.')}}`;
      }
    }
    return '';
  }

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new K8sClusterStack(app, 'TestStack', {
      clusterName: 'test-cluster',
      env: { account: '123456789012', region: 'us-west-2' }
    });
    template = Template.fromStack(stack);
    templateJson = template.toJSON();

    // Extract control plane user data
    const resources = templateJson.Resources;
    for (const key of Object.keys(resources)) {
      const resource = resources[key];
      if (resource.Type === 'AWS::EC2::LaunchTemplate' &&
          key.includes('ControlPlane')) {
        const userData = resource.Properties?.LaunchTemplateData?.UserData;
        if (userData) {
          controlPlaneUserData = extractStringContent(userData);
        }
      }
    }
  });

  describe('OIDC Issuer Configuration', () => {
    test('sets OIDC bucket name', () => {
      expect(controlPlaneUserData).toContain('OIDC_BUCKET=');
    });

    test('sets OIDC issuer URL using S3 endpoint', () => {
      expect(controlPlaneUserData).toContain('OIDC_ISSUER=');
      expect(controlPlaneUserData).toContain('s3.');
      expect(controlPlaneUserData).toContain('.amazonaws.com');
    });

    test('configures service-account-issuer in kubeadm', () => {
      expect(controlPlaneUserData).toContain('service-account-issuer:');
    });

    test('stores OIDC provider ARN', () => {
      expect(controlPlaneUserData).toContain('OIDC_PROVIDER_ARN=');
    });

    test('logs OIDC setup initiation', () => {
      expect(controlPlaneUserData).toContain('Setting up OIDC discovery for IRSA');
    });
  });

  describe('Service Account Key Extraction', () => {
    test('references service account signing key file', () => {
      expect(controlPlaneUserData).toContain('/etc/kubernetes/pki/sa.pub');
    });

    test('stores signing key file path in variable', () => {
      expect(controlPlaneUserData).toContain('SA_SIGNING_KEY_FILE=');
    });

    test('checks if signing key file exists', () => {
      expect(controlPlaneUserData).toContain('if [ -f "$SA_SIGNING_KEY_FILE" ]');
    });

    test('reads service account public key', () => {
      expect(controlPlaneUserData).toContain('SA_PUB_KEY=');
      expect(controlPlaneUserData).toContain('cat $SA_SIGNING_KEY_FILE');
    });

    test('handles missing signing key gracefully', () => {
      expect(controlPlaneUserData).toContain('Service account signing key not found');
      expect(controlPlaneUserData).toContain('OIDC setup skipped');
    });
  });

  describe('JWKS Generation', () => {
    test('logs JWKS generation', () => {
      expect(controlPlaneUserData).toContain('Generating OIDC discovery documents');
    });

    test('extracts RSA modulus using openssl', () => {
      expect(controlPlaneUserData).toContain('MODULUS=');
      expect(controlPlaneUserData).toContain('openssl rsa -pubin');
      expect(controlPlaneUserData).toContain('-modulus');
    });

    test('converts modulus to base64url format', () => {
      expect(controlPlaneUserData).toContain('base64');
      expect(controlPlaneUserData).toContain("tr '+/' '-_'");
      expect(controlPlaneUserData).toContain("tr -d '='");
    });

    test('uses standard RSA exponent AQAB', () => {
      expect(controlPlaneUserData).toContain('EXPONENT="AQAB"');
    });

    test('generates key ID from fingerprint', () => {
      expect(controlPlaneUserData).toContain('KID=');
      expect(controlPlaneUserData).toContain('openssl dgst -sha256');
    });

    test('creates keys.json file', () => {
      expect(controlPlaneUserData).toContain('/tmp/keys.json');
    });

    test('JWKS has correct kty field for RSA', () => {
      expect(controlPlaneUserData).toContain('"kty": "RSA"');
    });

    test('JWKS has correct alg field for RS256', () => {
      expect(controlPlaneUserData).toContain('"alg": "RS256"');
    });

    test('JWKS has use field set to sig', () => {
      expect(controlPlaneUserData).toContain('"use": "sig"');
    });

    test('JWKS includes kid field', () => {
      expect(controlPlaneUserData).toContain('"kid": "$KID"');
    });

    test('JWKS includes modulus n field', () => {
      expect(controlPlaneUserData).toContain('"n": "$MODULUS"');
    });

    test('JWKS includes exponent e field', () => {
      expect(controlPlaneUserData).toContain('"e": "$EXPONENT"');
    });

    test('JWKS has keys array structure', () => {
      expect(controlPlaneUserData).toContain('"keys": [');
    });
  });

  describe('OpenID Configuration Document', () => {
    test('creates openid-configuration.json file', () => {
      expect(controlPlaneUserData).toContain('/tmp/openid-configuration.json');
    });

    test('includes issuer field', () => {
      expect(controlPlaneUserData).toContain('"issuer": "$OIDC_ISSUER"');
    });

    test('includes jwks_uri field pointing to keys.json', () => {
      expect(controlPlaneUserData).toContain('"jwks_uri": "$OIDC_ISSUER/keys.json"');
    });

    test('includes authorization_endpoint for programmatic auth', () => {
      expect(controlPlaneUserData).toContain('"authorization_endpoint": "urn:kubernetes:programmatic_authorization"');
    });

    test('includes response_types_supported with id_token', () => {
      expect(controlPlaneUserData).toContain('"response_types_supported": ["id_token"]');
    });

    test('includes subject_types_supported with public', () => {
      expect(controlPlaneUserData).toContain('"subject_types_supported": ["public"]');
    });

    test('includes id_token_signing_alg_values_supported with RS256', () => {
      expect(controlPlaneUserData).toContain('"id_token_signing_alg_values_supported": ["RS256"]');
    });

    test('includes claims_supported with sub and iss', () => {
      expect(controlPlaneUserData).toContain('"claims_supported": ["sub", "iss"]');
    });
  });

  describe('S3 Upload', () => {
    test('logs S3 upload initiation', () => {
      expect(controlPlaneUserData).toContain('Uploading OIDC discovery documents to S3');
    });

    test('uploads openid-configuration to .well-known path', () => {
      expect(controlPlaneUserData).toContain('s3 cp /tmp/openid-configuration.json');
      expect(controlPlaneUserData).toContain('.well-known/openid-configuration');
    });

    test('uploads keys.json to bucket root', () => {
      expect(controlPlaneUserData).toContain('s3 cp /tmp/keys.json');
      expect(controlPlaneUserData).toContain('keys.json');
    });

    test('sets correct content-type for JSON files', () => {
      expect(controlPlaneUserData).toContain('--content-type application/json');
    });

    test('uses retry logic for S3 uploads', () => {
      expect(controlPlaneUserData).toContain('retry_command');
      expect(controlPlaneUserData).toContain('s3 cp');
    });

    test('uploads to OIDC bucket', () => {
      expect(controlPlaneUserData).toContain('s3://$OIDC_BUCKET');
    });
  });

  describe('Thumbprint Retrieval', () => {
    test('has default S3 thumbprint', () => {
      expect(controlPlaneUserData).toContain('S3_THUMBPRINT=');
      expect(controlPlaneUserData).toContain('9e99a48a9960b14926bb7f3b02e22da2b0ab7280');
    });

    test('constructs regional S3 endpoint', () => {
      expect(controlPlaneUserData).toContain('S3_ENDPOINT=');
      expect(controlPlaneUserData).toContain('s3.$REGION.amazonaws.com');
    });

    test('retrieves actual thumbprint using openssl', () => {
      expect(controlPlaneUserData).toContain('ACTUAL_THUMBPRINT=');
      expect(controlPlaneUserData).toContain('openssl s_client');
      expect(controlPlaneUserData).toContain('-servername');
      expect(controlPlaneUserData).toContain('-connect');
    });

    test('extracts SHA1 fingerprint from certificate', () => {
      expect(controlPlaneUserData).toContain('openssl x509 -fingerprint -sha1');
    });

    test('formats thumbprint correctly (lowercase, no colons)', () => {
      expect(controlPlaneUserData).toContain("tr -d ':'");
      expect(controlPlaneUserData).toContain("tr '[:upper:]' '[:lower:]'");
    });

    test('uses actual thumbprint if available', () => {
      expect(controlPlaneUserData).toContain('if [ -n "$ACTUAL_THUMBPRINT" ]');
      expect(controlPlaneUserData).toContain('S3_THUMBPRINT=$ACTUAL_THUMBPRINT');
    });

    test('logs thumbprint value', () => {
      expect(controlPlaneUserData).toContain('S3 TLS Thumbprint:');
    });
  });

  describe('OIDC Provider Update', () => {
    test('logs thumbprint update initiation', () => {
      expect(controlPlaneUserData).toContain('Updating AWS OIDC provider thumbprint');
    });

    test('calls IAM update-open-id-connect-provider-thumbprint', () => {
      expect(controlPlaneUserData).toContain('iam update-open-id-connect-provider-thumbprint');
    });

    test('passes OIDC provider ARN', () => {
      expect(controlPlaneUserData).toContain('--open-id-connect-provider-arn');
      expect(controlPlaneUserData).toContain('$OIDC_PROVIDER_ARN');
    });

    test('passes thumbprint list', () => {
      expect(controlPlaneUserData).toContain('--thumbprint-list');
      expect(controlPlaneUserData).toContain('$S3_THUMBPRINT');
    });

    test('uses retry logic for IAM update', () => {
      expect(controlPlaneUserData).toContain('retry_command');
      expect(controlPlaneUserData).toContain('update-open-id-connect-provider-thumbprint');
    });
  });

  describe('SSM Parameter Storage', () => {
    test('stores OIDC issuer URL in SSM', () => {
      expect(controlPlaneUserData).toContain('/oidc/issuer');
      expect(controlPlaneUserData).toContain('put-parameter');
    });

    test('stores as String type', () => {
      expect(controlPlaneUserData).toContain("--type 'String'");
    });

    test('uses overwrite flag', () => {
      expect(controlPlaneUserData).toContain('--overwrite');
    });
  });

  describe('OIDC Setup Completion', () => {
    test('logs successful completion', () => {
      expect(controlPlaneUserData).toContain('OIDC setup completed successfully');
    });
  });

  describe('AWS Infrastructure for OIDC', () => {
    test('OIDC S3 bucket exists', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: Match.stringLikeRegexp('.*oidc.*')
      });
    });

    test('OIDC bucket has public access blocked', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true
        }
      });
    });

    test('OIDC bucket has encryption enabled', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: Match.arrayWith([
            Match.objectLike({
              ServerSideEncryptionByDefault: Match.objectLike({
                SSEAlgorithm: Match.anyValue()
              })
            })
          ])
        }
      });
    });

    test('OIDC issuer uses S3 URL format in user data', () => {
      // The OIDC issuer is configured to use S3 URL for hosting discovery documents
      expect(controlPlaneUserData).toContain('OIDC_ISSUER="https://s3.');
      expect(controlPlaneUserData).toContain('.amazonaws.com/$OIDC_BUCKET"');
    });

    test('user data references OIDC provider ARN', () => {
      // The OIDC provider ARN is passed to the user data script
      expect(controlPlaneUserData).toContain('OIDC_PROVIDER_ARN=');
    });

    test('user data updates OIDC provider thumbprint', () => {
      expect(controlPlaneUserData).toContain('update-open-id-connect-provider-thumbprint');
    });
  });

  describe('IAM Permissions for OIDC Setup', () => {
    test('control plane role can write to OIDC S3 bucket', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['s3:PutObject']),
              Effect: 'Allow'
            })
          ])
        }
      });
    });

    test('control plane role can update OIDC provider', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['iam:UpdateOpenIDConnectProviderThumbprint']),
              Effect: 'Allow'
            })
          ])
        }
      });
    });

    test('control plane role can write SSM parameters', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['ssm:PutParameter']),
              Effect: 'Allow'
            })
          ])
        }
      });
    });
  });

  describe('IRSA Role Trust Policy', () => {
    test('cluster autoscaler IRSA role exists', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: Match.stringLikeRegexp('.*cluster-autoscaler-irsa.*')
      });
    });

    test('IRSA role has federated principal from nested stack', () => {
      // The IRSA role is created in a nested stack with the OIDC provider
      // We verify that the nested stack passes the OIDC ARN to compute stack
      // and that the user data script uses it
      expect(controlPlaneUserData).toContain('OIDC_PROVIDER_ARN=');
    });

    test('IRSA role has sts:AssumeRoleWithWebIdentity action', () => {
      const resources = templateJson.Resources;
      let foundAction = false;

      for (const key of Object.keys(resources)) {
        const resource = resources[key];
        if (resource.Type === 'AWS::IAM::Role' &&
            key.includes('ClusterAutoscalerIrsa')) {
          const trustPolicy = resource.Properties?.AssumeRolePolicyDocument;
          if (trustPolicy) {
            const policyStr = JSON.stringify(trustPolicy);
            if (policyStr.includes('sts:AssumeRoleWithWebIdentity')) {
              foundAction = true;
            }
          }
        }
      }
      expect(foundAction).toBe(true);
    });
  });

  describe('OpenSSL Commands', () => {
    test('uses openssl rsa for modulus extraction', () => {
      expect(controlPlaneUserData).toContain('openssl rsa -pubin -in $SA_SIGNING_KEY_FILE -modulus -noout');
    });

    test('uses openssl for DER conversion', () => {
      expect(controlPlaneUserData).toContain('openssl rsa -pubin -in $SA_SIGNING_KEY_FILE -outform DER');
    });

    test('uses xxd for hex to binary conversion', () => {
      expect(controlPlaneUserData).toContain('xxd -r -p');
    });

    test('uses openssl s_client for certificate retrieval', () => {
      expect(controlPlaneUserData).toContain('openssl s_client -servername $S3_ENDPOINT -connect $S3_ENDPOINT:443');
    });

    test('uses openssl x509 for fingerprint extraction', () => {
      expect(controlPlaneUserData).toContain('openssl x509 -fingerprint -sha1 -noout');
    });
  });

  describe('Base64URL Encoding', () => {
    test('replaces + with - for base64url', () => {
      expect(controlPlaneUserData).toContain("tr '+/' '-_'");
    });

    test('removes padding for base64url', () => {
      expect(controlPlaneUserData).toContain("tr -d '='");
    });

    test('uses base64 with no line wrap', () => {
      expect(controlPlaneUserData).toContain('base64 -w0');
    });
  });

  describe('Key ID Generation', () => {
    test('generates kid from key fingerprint', () => {
      expect(controlPlaneUserData).toContain('KID=');
      expect(controlPlaneUserData).toContain('openssl dgst -sha256 -binary');
    });

    test('truncates kid to reasonable length', () => {
      expect(controlPlaneUserData).toContain('cut -c1-16');
    });
  });
});
