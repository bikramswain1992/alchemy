# Azure Function App

An Effect-native HTTP function on Azure Functions v4, Linux Node.js 22, and Flex Consumption. The stack creates a resource group, StorageV2 account, private deployment container, FC1 plan, and Function App. Alchemy assigns the app's managed identity its storage roles before publishing code. The endpoint is public and requires no Function key.

## Authenticate

For local development, install the Azure CLI, run `az login`, and select an enabled subscription with `az account set --subscription <subscription-id>`. The identity must be able to create resource groups, storage accounts, Function Apps, plans, and role assignments. The default Azure location is `eastus`; configure another Flex-supported location in the Azure profile or on the resources if needed.

For CI, set `AZURE_SUBSCRIPTION_ID`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_SECRET` for a service principal. Optionally set `AZURE_LOCATION` to a Flex-supported region. Tokens are refreshed as needed. Grant the principal permissions to create resources and assign storage roles in the target subscription. The live lifecycle test uses the Azure CLI identity (`--profile testing`) and requires these same resource and role-assignment permissions.

## Run

From this directory, run `pnpm deploy`, then request the emitted `url` with `curl <url>`. Run `pnpm destroy` to remove the stack. `Alchemy.localState()` persists stack state on the machine running the command; keep that state between deploy and destroy.
