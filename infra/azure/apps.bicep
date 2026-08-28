targetScope = 'resourceGroup'

metadata name = 'FieldMerge Container Apps'
metadata description = 'One warm public web entry point and one warm internal API for the bounded FieldMerge portfolio demo.'

param location string = resourceGroup().location

@minLength(3)
@maxLength(15)
param namePrefix string = 'fieldmerge'

@minLength(2)
@maxLength(7)
param environmentName string = 'prod'

@description('Name of the Container Apps environment created by foundation.bicep.')
param containerAppsEnvironmentName string = 'cae-${toLower(namePrefix)}-${toLower(environmentName)}'

@minLength(1)
@description('Immutable public GHCR frontend image tag or digest.')
param frontendImage string

@minLength(1)
@description('Immutable public GHCR backend image tag or digest.')
param backendImage string

@secure()
@minLength(1)
@description('Complete SQLAlchemy asyncpg database URL, including ssl=require.')
param databaseUrl string

@description('Optional custom hostname for the public web app. Supply it with its certificate ID.')
param webCustomDomainName string = ''

@description('Optional Azure managed-certificate resource ID for webCustomDomainName.')
param webCustomDomainCertificateId string = ''

@description('Optional custom hostname browsers will use. It is allowlisted before certificate binding.')
param browserCustomDomainName string = ''

@minValue(1)
param webMinReplicas int = 1

@minValue(1)
param webMaxReplicas int = 1

@minValue(1)
param apiMinReplicas int = 1

@minValue(1)
param apiMaxReplicas int = 1

@minValue(100)
@description('Maximum number of operations retained for the fixed demonstration document.')
param maxLogOperations int = 1000

@description('Optional additional resource tags.')
param tags object = {}

var normalizedPrefix = toLower(namePrefix)
var normalizedEnvironment = toLower(environmentName)
var webAppName = '${normalizedPrefix}-web-${normalizedEnvironment}'
var apiAppName = '${normalizedPrefix}-api-${normalizedEnvironment}'
var apiInternalOrigin = 'http://${apiAppName}'
var webCustomDomains = !empty(webCustomDomainName) && !empty(webCustomDomainCertificateId) ? [
  {
    name: webCustomDomainName
    bindingType: 'SniEnabled'
    certificateId: webCustomDomainCertificateId
  }
] : []
var resourceTags = union({
  application: 'FieldMerge'
  environment: normalizedEnvironment
  managedBy: 'Bicep'
  workload: 'public-demo'
}, tags)

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2026-01-01' existing = {
  name: containerAppsEnvironmentName
}

var generatedWebOrigin = 'https://${webAppName}.${containerAppsEnvironment.properties.defaultDomain}'
var browserOrigins = empty(browserCustomDomainName) ? [
  generatedWebOrigin
] : [
  generatedWebOrigin
  'https://${browserCustomDomainName}'
]

resource apiApp 'Microsoft.App/containerApps@2026-01-01' = {
  name: apiAppName
  location: location
  tags: resourceTags
  properties: {
    configuration: {
      activeRevisionsMode: 'Single'
      maxInactiveRevisions: 3
      ingress: {
        allowInsecure: false
        external: false
        targetPort: 8000
        transport: 'auto'
      }
      secrets: [
        {
          name: 'database-url'
          value: databaseUrl
        }
      ]
    }
    environmentId: containerAppsEnvironment.id
    template: {
      containers: [
        {
          name: 'api'
          image: backendImage
          command: [
            'uvicorn'
          ]
          args: [
            'fieldmerge.main:app'
            '--host'
            '0.0.0.0'
            '--port'
            '8000'
            '--proxy-headers'
          ]
          env: [
            {
              name: 'FIELDMERGE_ENVIRONMENT'
              value: 'production'
            }
            {
              name: 'FIELDMERGE_DATABASE_URL'
              secretRef: 'database-url'
            }
            {
              name: 'FIELDMERGE_AUTO_CREATE_SCHEMA'
              value: 'false'
            }
            {
              name: 'FIELDMERGE_SQL_ECHO'
              value: 'false'
            }
            {
              name: 'FIELDMERGE_PUBLIC_DEMO_MODE'
              value: 'true'
            }
            {
              name: 'FIELDMERGE_MAX_PENDING_OPERATIONS'
              value: '20'
            }
            {
              name: 'FIELDMERGE_MAX_LOG_OPERATIONS'
              value: string(maxLogOperations)
            }
            {
              name: 'FIELDMERGE_DATABASE_POOL_SIZE'
              value: '3'
            }
            {
              name: 'FIELDMERGE_DATABASE_MAX_OVERFLOW'
              value: '1'
            }
            {
              name: 'FIELDMERGE_CORS_ORIGINS'
              value: string(browserOrigins)
            }
          ]
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: '/health/live'
                port: 8000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 1
              periodSeconds: 2
              timeoutSeconds: 2
              failureThreshold: 30
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/health/live'
                port: 8000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 15
              timeoutSeconds: 3
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health/ready'
                port: 8000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 3
              periodSeconds: 10
              timeoutSeconds: 3
              failureThreshold: 3
            }
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
      scale: {
        minReplicas: apiMinReplicas
        maxReplicas: apiMaxReplicas
        rules: [
          {
            name: 'api-http'
            http: {
              metadata: {
                concurrentRequests: '25'
              }
            }
          }
        ]
      }
      terminationGracePeriodSeconds: 30
    }
    workloadProfileName: 'Consumption'
  }
}

resource webApp 'Microsoft.App/containerApps@2026-01-01' = {
  name: webAppName
  location: location
  tags: resourceTags
  properties: {
    configuration: {
      activeRevisionsMode: 'Single'
      maxInactiveRevisions: 3
      ingress: {
        allowInsecure: false
        customDomains: webCustomDomains
        external: true
        targetPort: 8080
        transport: 'auto'
      }
    }
    environmentId: containerAppsEnvironment.id
    template: {
      containers: [
        {
          name: 'web'
          image: frontendImage
          env: [
            {
              name: 'API_UPSTREAM'
              value: apiInternalOrigin
            }
          ]
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: '/healthz'
                port: 8080
                scheme: 'HTTP'
              }
              initialDelaySeconds: 1
              periodSeconds: 2
              timeoutSeconds: 2
              failureThreshold: 20
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/healthz'
                port: 8080
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 15
              timeoutSeconds: 3
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health/ready'
                port: 8080
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              timeoutSeconds: 5
              failureThreshold: 3
            }
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
      scale: {
        minReplicas: webMinReplicas
        maxReplicas: webMaxReplicas
        rules: [
          {
            name: 'web-http'
            http: {
              metadata: {
                concurrentRequests: '50'
              }
            }
          }
        ]
      }
      terminationGracePeriodSeconds: 30
    }
    workloadProfileName: 'Consumption'
  }
  dependsOn: [
    apiApp
  ]
}

output webAppName string = webApp.name
output webAppUrl string = 'https://${webApp.properties.configuration.ingress.fqdn}'
output apiAppName string = apiApp.name
output apiAppFqdn string = apiApp.properties.configuration.ingress.fqdn
