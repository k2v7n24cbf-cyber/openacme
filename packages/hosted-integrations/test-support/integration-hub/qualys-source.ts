export const LEGACY_INTEGRATION_HUB_QUALYS_SOURCE_PATH =
  "tmp/openacme-realdata-test-20260724-103001/agents/mcp-server-admin-and-developer/workspace/src/integration_hub/integrations/qualys";

export function qualysFiveReadOnlySourceBackedFamilyYaml(): string {
  return `
id: qualys
name: Qualys
version: 1
runtime:
  language: python
  entrypoint: qualys.py
  defaultTimeoutMs: 30000
  inlineResultTokenLimit: 8000
  maxConcurrency: 2
  runtimePolicy:
    filesystem: run_dir_and_family_home
    processEnv: tool_context_only
    subprocess: denied
    network: declared_egress
    declaredEgress:
      - qualys
  dependencyPolicy:
    installDuringInvocation: false
    allowedPackages: []
runtimeConfig:
  requiredConfigKeys:
    - QUALYS_VM_URL
  requiredSecretKeys:
    - QUALYS_USERNAME
    - QUALYS_PASSWORD
tools:
  - name: qualys_gav_asset_count
    title: Qualys GAV Asset Count
    description: Source-backed port of legacy integration-hub Qualys count_assets for CSAM/GAV asset counts. filter_body must use native Qualys GAV filter tokens such as asset.name, operatingSystem.category1, qualys.agent.lastCheckedInDate, and asset.trackingMethod; response projection fields such as assetName are not valid filter fields.
    inputSchema:
      type: object
      properties:
        asset_last_updated:
          type: string
        filter_body:
          type: object
          description: Native Qualys GAV FilterRequest JSON body, for example {"filters":[{"field":"asset.name","operator":"EQUALS","value":"host01"}]}. Do not pass a bare Criteria object.
          additionalProperties: true
        search_body:
          type: object
          description: Deprecated alias for filter_body.
          additionalProperties: true
        filter_xml:
          type: string
        last_seen_asset_id:
          type: integer
      additionalProperties: false
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
${qualysGavAssetCountHelpYaml()}
  - name: qualys_gav_asset_search
    title: Qualys GAV Asset Search
    description: Source-backed port of legacy integration-hub Qualys list_assets for CSAM/GAV asset search.
    inputSchema:
      type: object
      properties:
        page_size:
          type: integer
        max_pages:
          type: integer
        detail_level:
          type: string
        include_fields:
          type: array
          items:
            type: string
        exclude_fields:
          type: array
          items:
            type: string
        asset_last_updated:
          type: string
        filter_body:
          type: object
          description: Native Qualys GAV FilterRequest JSON body.
          additionalProperties: true
        search_body:
          type: object
          description: Deprecated alias for filter_body.
          additionalProperties: true
        filter_xml:
          type: string
        last_seen_asset_id:
          type: integer
      additionalProperties: false
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
${qualysGavAssetSearchHelpYaml()}
  - name: qualys_cloud_agent_hostasset_count
    title: Qualys Cloud Agent Hostasset Count
    description: Source-backed Qualys Cloud Agent count using CSAM/GAV asset.trackingMethod EQUALS QAGENT filter semantics. Caller filters are ANDed with QAGENT and must use native Qualys GAV filter tokens such as asset.name, operatingSystem.category1, or qualys.agent.lastCheckedInDate; response projection fields such as assetName are not valid filter fields.
    inputSchema:
      type: object
      properties:
        asset_last_updated:
          type: string
        filter_body:
          type: object
          description: Native Qualys GAV FilterRequest JSON body. The tool adds asset.trackingMethod EQUALS QAGENT automatically. Use native filter tokens, not returned field names.
          additionalProperties: true
        search_body:
          type: object
          description: Deprecated alias for filter_body.
          additionalProperties: true
        last_seen_asset_id:
          type: integer
      additionalProperties: false
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
${qualysCloudAgentCountHelpYaml()}
  - name: qualys_cloud_agent_hostasset_search
    title: Qualys Cloud Agent Hostasset Search
    description: Source-backed Qualys Cloud Agent search using CSAM/GAV asset.trackingMethod EQUALS QAGENT filter semantics.
    inputSchema:
      type: object
      properties:
        page_size:
          type: integer
        max_pages:
          type: integer
        detail_level:
          type: string
        include_fields:
          type: array
          items:
            type: string
        exclude_fields:
          type: array
          items:
            type: string
        asset_last_updated:
          type: string
        filter_body:
          type: object
          description: Native Qualys GAV FilterRequest JSON body. The tool adds asset.trackingMethod EQUALS QAGENT automatically.
          additionalProperties: true
        search_body:
          type: object
          description: Deprecated alias for filter_body.
          additionalProperties: true
        last_seen_asset_id:
          type: integer
      additionalProperties: false
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
${qualysCloudAgentSearchHelpYaml()}
  - name: qualys_vmdr_host_list
    title: Qualys VMDR Host List
    description: Source-backed port of legacy integration-hub Qualys list_hosts for VMDR Host List API v5.
    inputSchema:
      type: object
      properties:
        params:
          type: object
          description: Native Qualys Host List query parameters, excluding tracking_method/trackingMethod.
          additionalProperties: true
        truncation_limit:
          type: integer
        max_pages:
          type: integer
        tracking_method:
          type: string
          description: Unsupported and rejected when present.
      additionalProperties: false
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
${qualysVmdrHostListHelpYaml()}
`;
}

function qualysGavAssetCountHelpYaml(): string {
  return `
    help:
      summary: Count CSAM/GAV assets matching optional native Qualys filters.
      full: |
        Counts assets through the Qualys Gateway count endpoint. Use this when
        the caller needs only a count, not asset records. Filters must use
        native Qualys GAV filter field tokens such as asset.name,
        operatingSystem.category1, qualys.agent.lastCheckedInDate, or
        asset.trackingMethod. Returned response field names such as assetName
        are not valid filter fields.
      whenToUse:
        - Count assets by native GAV filters.
        - Verify whether a filter matches any assets before running a search.
      whenNotToUse:
        - Do not use when asset records or pagination are required.
        - Do not use response projection fields as filter field names.
      parameters:
        filter_body:
          summary: Native Qualys GAV FilterRequest JSON body.
          full: |
            Pass an object shaped like {"filters":[{"field":"asset.name",
            "operator":"EQUALS","value":"host01"}]}. A legacy
            ServiceRequest.filters.Criteria wrapper is accepted and normalized,
            but a bare Criteria object is not. The operation defaults to Qualys
            native behavior unless supplied by the caller.
          rules:
            - Use native GAV filter field tokens, not response field names.
            - assetName is invalid; use asset.name.
            - asset_last_updated is a hosted tool request parameter, not a filter field token.
            - qualys.agent.lastCheckedInDate is the Cloud Agent check-in field token.
          examples:
            - filter_body:
                filters:
                  - field: asset.name
                    operator: EQUALS
                    value: definitely-missing-host
        filter_body.filters.field:
          summary: Native Qualys GAV filter token.
          full: Use asset.name, operatingSystem.category1, qualys.agent.lastCheckedInDate, or another documented GAV token. Do not use assetName or hosted request parameters such as asset_last_updated.
        filter_body.filters.operator:
          summary: Native Qualys operator such as EQUALS, CONTAINS, GREATER, or LESSER.
        filter_body.filters.value:
          summary: Filter value sent to Qualys without platform-side caching.
        asset_last_updated:
          summary: Optional top-level assetLastUpdated query value forwarded to the GAV endpoint; do not put asset_last_updated in filter_body.filters.field.
        search_body:
          summary: Deprecated alias for filter_body.
          full: Prefer filter_body. search_body accepts the same native Qualys GAV FilterRequest JSON body and cannot be combined with filter_body.
        filter_xml:
          summary: Optional legacy XML filter body for GAV count.
          full: Use only when the caller already has a valid Qualys Gateway XML filter. Do not combine filter_xml with filter_body or search_body.
        last_seen_asset_id:
          summary: Optional lastSeenAssetId cursor value for legacy compatibility.
      examples:
        - filter_body:
            filters:
              - field: asset.name
                operator: EQUALS
                value: definitely-missing-host
`;
}

function qualysGavAssetSearchHelpYaml(): string {
  return `
    help:
      summary: Search CSAM/GAV assets and return matching records.
      full: |
        Searches assets through the Qualys Gateway search endpoint. Use this
        when the caller needs records, selected fields, or pagination. Filter
        syntax is Qualys-native; response projection names are not valid filter
        tokens.
      whenToUse:
        - Retrieve asset records by native GAV filters.
        - Page through CSAM/GAV search results.
      whenNotToUse:
        - Use the count tool when only cardinality is needed.
      parameters:
        page_size:
          summary: Optional Qualys page size for asset search.
          full: Positive integer forwarded as pageSize. Use conservative values for live Qualys calls to avoid target-side throttling.
        max_pages:
          summary: Optional maximum number of pages to fetch.
          full: Positive integer cap for pagination. Use this to bound runtime and response size.
        detail_level:
          summary: Optional Qualys asset detail level.
        filter_body:
          summary: Native Qualys GAV FilterRequest JSON body.
          full: Use the same FilterRequest shape as the count tool. The request may include filters and an operation accepted by Qualys.
          rules:
            - Use asset.name instead of assetName.
            - asset_last_updated is a hosted tool request parameter, not a filter field token.
            - Use qualys.agent.lastCheckedInDate for Cloud Agent check-in filtering.
        include_fields:
          summary: Optional response field projection list for returned asset records.
          full: List response projection fields to keep in the returned records. Use exclude_fields instead when removing a small number of fields.
        exclude_fields:
          summary: Optional response field exclusion list for returned asset records.
          full: List response projection fields to omit. Do not combine with include_fields.
        last_seen_asset_id:
          summary: Optional pagination cursor forwarded as lastSeenAssetId.
        asset_last_updated:
          summary: Optional top-level assetLastUpdated query value forwarded to Qualys; do not put asset_last_updated in filter_body.filters.field.
        search_body:
          summary: Deprecated alias for filter_body.
          full: Prefer filter_body. search_body accepts the same native Qualys GAV FilterRequest JSON body and cannot be combined with filter_body.
        filter_xml:
          summary: Optional legacy XML filter body for GAV search.
          full: Use only when the caller already has a valid Qualys Gateway XML filter. Do not combine filter_xml with filter_body or search_body.
      examples:
        - filter_body:
            filters:
              - field: asset.name
                operator: EQUALS
                value: definitely-missing-host
`;
}

function qualysCloudAgentCountHelpYaml(): string {
  return `
    help:
      summary: Count Cloud Agent assets; the tool automatically scopes results to QAGENT.
      full: |
        Counts Cloud Agent assets by ANDing caller filters with
        asset.trackingMethod EQUALS QAGENT. The caller must not provide
        operation OR or override trackingMethod to a non-QAGENT value. Use
        native GAV filter tokens such as asset.name or
        qualys.agent.lastCheckedInDate.
      whenToUse:
        - Count Cloud Agent host assets.
        - Verify last check-in filters before a record search.
      whenNotToUse:
        - Do not use for non-agent VMDR Host List queries.
        - Do not pass operation OR.
      parameters:
        filter_body:
          summary: Native GAV FilterRequest JSON body ANDed with QAGENT scope.
          full: |
            The tool injects asset.trackingMethod EQUALS QAGENT and combines it
            with caller filters using AND. If the caller supplies
            asset.trackingMethod, it must be QAGENT. operation OR is rejected
            because it would escape the Cloud Agent scope.
          rules:
            - asset.trackingMethod EQUALS QAGENT is enforced automatically.
            - operation must be absent or AND.
            - asset.trackingMethod values other than QAGENT are rejected.
            - asset_last_updated is a hosted tool request parameter, not a filter field token.
            - Use qualys.agent.lastCheckedInDate for Cloud Agent check-in filters.
        filter_body.filters.field:
          summary: Native GAV filter token; use asset.name, not assetName.
          full: Native Qualys GAV token. For Cloud Agent last check-in, use qualys.agent.lastCheckedInDate. Do not use hosted request parameters such as asset_last_updated as filter fields.
        filter_body.filters.operator:
          summary: Native Qualys operator such as EQUALS, CONTAINS, GREATER, or LESSER.
        filter_body.filters.value:
          summary: Filter value sent to Qualys.
        filter_body.operation:
          summary: Must be absent or AND for Cloud Agent tools.
          full: OR is rejected because the tool must keep every result scoped to QAGENT.
        asset_last_updated:
          summary: Optional top-level assetLastUpdated query value forwarded to Qualys; do not put asset_last_updated in filter_body.filters.field.
        search_body:
          summary: Deprecated alias for filter_body.
          full: Prefer filter_body. search_body accepts the same native Qualys GAV FilterRequest JSON body and is also ANDed with QAGENT scope.
        last_seen_asset_id:
          summary: Optional lastSeenAssetId cursor value for legacy compatibility.
      examples:
        - filter_body:
            filters:
              - field: qualys.agent.lastCheckedInDate
                operator: LESSER
                value: "2026-07-01T00:00:00Z"
`;
}

function qualysCloudAgentSearchHelpYaml(): string {
  return `
    help:
      summary: Search Cloud Agent asset records with automatic QAGENT scoping.
      full: |
        Searches CSAM/GAV asset records while enforcing
        asset.trackingMethod EQUALS QAGENT. Caller filters are combined with
        AND. Use this for Cloud Agent record retrieval, not for VMDR host list
        XML queries.
      whenToUse:
        - Retrieve Cloud Agent asset records.
        - Page through Cloud Agent assets using GAV search semantics.
      whenNotToUse:
        - Do not use operation OR or non-QAGENT trackingMethod filters.
      parameters:
        page_size:
          summary: Optional Qualys page size for Cloud Agent asset search.
          full: Positive integer forwarded as pageSize. Use conservative values for live Qualys calls to avoid target-side throttling.
        max_pages:
          summary: Optional maximum number of pages to fetch.
          full: Positive integer cap for pagination. Use this to bound runtime and response size.
        detail_level:
          summary: Optional Qualys asset detail level.
        filter_body:
          summary: Native GAV FilterRequest JSON body ANDed with QAGENT scope.
          full: The tool enforces QAGENT scope exactly like the Cloud Agent count tool.
          rules:
            - operation must be absent or AND.
            - Use asset.name instead of assetName.
            - asset_last_updated is a hosted tool request parameter, not a filter field token.
            - Use qualys.agent.lastCheckedInDate for Cloud Agent last check-in.
        include_fields:
          summary: Optional response field projection list.
          full: List response projection fields to keep in returned Cloud Agent records. Do not combine with exclude_fields.
        exclude_fields:
          summary: Optional response field exclusion list.
          full: List response projection fields to omit. Do not combine with include_fields.
        last_seen_asset_id:
          summary: Optional pagination cursor forwarded as lastSeenAssetId.
        asset_last_updated:
          summary: Optional top-level assetLastUpdated query value forwarded to Qualys; do not put asset_last_updated in filter_body.filters.field.
        search_body:
          summary: Deprecated alias for filter_body.
          full: Prefer filter_body. search_body accepts the same native Qualys GAV FilterRequest JSON body and is also ANDed with QAGENT scope.
      examples:
        - filter_body:
            filters:
              - field: asset.name
                operator: EQUALS
                value: definitely-missing-host
`;
}

function qualysVmdrHostListHelpYaml(): string {
  return `
    help:
      summary: List VMDR Host List API v5 hosts with read-only filters.
      full: |
        Calls the Qualys VMDR Host List API v5. This is separate from CSAM/GAV
        Gateway asset search. Do not pass Cloud Agent tracking_method input to
        this tool; the tool rejects unsupported tracking_method arguments before
        credentials or network access.
      whenToUse:
        - Retrieve VMDR host records through Host List API v5.
      whenNotToUse:
        - Use Cloud Agent tools for QAGENT-scoped CSAM/GAV assets.
      parameters:
        params:
          summary: Native Qualys Host List query parameters.
          full: Optional key/value parameters forwarded to the VMDR Host List API v5 after the tool enforces action=list. Do not include tracking_method or trackingMethod.
        truncation_limit:
          summary: Optional Qualys Host List truncation_limit.
        max_pages:
          summary: Optional maximum number of Host List pages to fetch.
          full: Positive integer cap for pagination. Use this to bound runtime and response size.
        tracking_method:
          summary: Unsupported for this hosted VMDR tool and rejected when present.
          full: Cloud Agent tracking_method belongs to the CSAM/GAV Cloud Agent tools, not VMDR Host List API v5.
      examples:
        - details: Basic read-only VMDR host list call with no tracking_method override.
`;
}

export function qualysFiveReadOnlySourceBackedPythonSource(): string {
  return String.raw`"""Source-backed hosted Qualys read-only family.

This is a narrow port from the legacy integration-hub Qualys client:

- CSAM/GAV asset count/search use the Gateway /rest/2.0/count|search/am/asset
  endpoints and the same include/exclude, pagination, filter_body/filter_xml,
  assetLastUpdated, and lastSeenAssetId behavior.
- Cloud Agent hostasset count/search are the maintained QAGENT discovery flow
  from the Qualys toolkit: CSAM/GAV asset search/count plus
  asset.trackingMethod EQUALS QAGENT. They intentionally do not send
  tracking_method to VMDR Host List.
- VMDR host listing uses Host List API v5 and rejects tracking_method input
  before credentials or network are touched.

Credentials and endpoints come from hosted integration environment configs and
human-owned secrets in ToolContext. This module must not read process env.
"""

from __future__ import annotations

import base64
import json
import re
import ssl
import xml.etree.ElementTree as ET
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse, urlunparse
from urllib.request import Request, urlopen


ASSET_SUMMARY_FIELDS = [
    "assetId",
    "assetUUID",
    "hostId",
    "agentId",
    "assetType",
    "assetName",
    "dnsName",
    "dnsHostName",
    "netbiosName",
    "fqdn",
    "address",
    "biosSerialNumber",
    "biosAssetTag",
    "hwUUID",
    "cloudProvider",
    "provider",
    "operatingSystem",
    "networkInterfaceListData",
    "lastModifiedDate",
    "activity",
    "agent",
    "sensor",
    "tags",
    "tagList",
]

ASSET_DETAIL_FIELDS = ASSET_SUMMARY_FIELDS + [
    "openPortListData",
    "serviceList",
    "softwareListData",
    "userAccountListData",
    "hardware",
    "inventory",
    "inventoryListData",
    "processor",
    "softwareComponent",
    "missingSoftware",
    "volumeListData",
]

GAV_INCLUDE_EXCLUDE_FIELDS = [
    "address",
    "agent",
    "agentId",
    "assetName",
    "biosAssetTag",
    "biosSerialNumber",
    "cloudProvider",
    "dnsName",
    "hardware",
    "hostId",
    "inventory",
    "netbiosName",
    "networkInterface",
    "openPort",
    "operatingSystem",
    "processor",
    "provider",
    "sensor",
    "service",
    "software",
    "tag",
    "userAccount",
    "volume",
]

ASSET_FIELD_ALIASES = {
    "agent": ["agent", "agentId"],
    "dnsname": ["dnsName", "dnsHostName"],
    "dnshostname": ["dnsName", "dnsHostName"],
    "interfaces": ["interfaces", "networkInterfaceListData"],
    "networkinterface": ["networkInterfaceListData"],
    "inventory": ["inventory", "inventoryListData"],
    "openport": ["openPort", "openPorts", "openPortListData"],
    "software": ["software", "softwareListData", "softwareComponent"],
    "tag": ["tags", "tagList"],
    "tags": ["tags", "tagList"],
    "useraccount": ["userAccount", "userAccounts", "userAccountListData"],
    "volume": ["volume", "volumes", "volumeListData"],
}

GAV_INCLUDE_FIELD_ALIASES = {
    "dnshostname": "dnsName",
    "interfaces": "networkInterface",
    "networkinterfaces": "networkInterface",
    "networkinterfacelistdata": "networkInterface",
    "openports": "openPort",
    "openportlistdata": "openPort",
    "services": "service",
    "servicelist": "service",
    "softwarelistdata": "software",
    "softwarecomponent": "software",
    "tags": "tag",
    "taglist": "tag",
    "useraccounts": "userAccount",
    "useraccountlistdata": "userAccount",
    "volumes": "volume",
    "volumelistdata": "volume",
    "inventorylistdata": "inventory",
}

HOST_LIST_ENDPOINT = "/api/5.0/fo/asset/host/"
QAGENT_FILTER = {"field": "asset.trackingMethod", "operator": "EQUALS", "value": "QAGENT"}


class QualysToolError(Exception):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def list_tools():
    return []


def authenticate(ctx):
    return {"context": ctx, "client": None}


def before_tool_call(tool_name, args, ctx, auth):
    return args or {}


def after_tool_call(tool_name, args, ctx, result, auth):
    return result


def tool_qualys_vmdr_host_list(args, context):
    _validate_host_list_args(args)
    truncation_limit = args.get("truncation_limit")
    params = _native_params_arg(args)
    max_pages = _positive_int(args, "max_pages")
    client = _authenticated_client(context)
    return client.list_hosts(
        truncation_limit=truncation_limit,
        params=params,
        max_pages=max_pages,
    )


def tool_qualys_gav_asset_count(args, context):
    asset_last_updated = _optional_string(args, "asset_last_updated")
    filter_body = _gateway_filter_body_arg(args, allow_filter_xml=True)
    filter_xml = _gateway_filter_xml_arg(args)
    last_seen_asset_id = _positive_int(args, "last_seen_asset_id")
    client = _authenticated_client(context)
    return client.count_assets(
        asset_last_updated=asset_last_updated,
        filter_body=filter_body,
        filter_xml=filter_xml,
        last_seen_asset_id=last_seen_asset_id,
    )


def tool_qualys_gav_asset_search(args, context):
    client = _authenticated_client(context)
    return _list_assets_from_args(client, args)


def tool_qualys_cloud_agent_hostasset_count(args, context):
    filter_body = _qagent_filter_body(args)
    client = _authenticated_client(context)
    return client.count_assets(
        asset_last_updated=_optional_string(args, "asset_last_updated"),
        filter_body=filter_body,
        filter_xml=None,
        last_seen_asset_id=_positive_int(args, "last_seen_asset_id"),
    )


def tool_qualys_cloud_agent_hostasset_search(args, context):
    filter_body = _qagent_filter_body(args)
    client = _authenticated_client(context)
    return _list_assets_from_args(client, {**args, "filter_body": filter_body})


def _authenticated_client(context):
    auth = context["auth"]
    if auth["client"] is None:
        auth["client"] = QualysClient(auth["context"])
    return auth["client"]


class QualysClient:
    def __init__(self, context):
        self.config = context.get("config") or {}
        self.secrets = context.get("secrets") or {}
        self.vm_url = _config(self.config, "QUALYS_VM_URL", "vmUrl", "baseUrl", required=True).rstrip("/")
        self.gateway_url = (
            _config(self.config, "QUALYS_GATEWAY_URL", "gatewayUrl")
            or _derive_gateway_url(self.vm_url)
        ).rstrip("/")
        self.username = _secret(self.secrets, "QUALYS_USERNAME", "username", required=True)
        self.password = _secret(self.secrets, "QUALYS_PASSWORD", "password", required=True)
        self.verify_tls = str(_config(self.config, "QUALYS_VERIFY_TLS", "verifyTls", default="1")) != "0"
        self.timeout = float(_config(self.config, "QUALYS_TIMEOUT_SECONDS", "timeoutSeconds", default="120"))
        self.default_truncation_limit = int(_config(self.config, "QUALYS_TRUNCATION_LIMIT", "truncationLimit", default="100"))
        self.default_asset_page_size = int(_config(self.config, "QUALYS_ASSET_PAGE_SIZE", "assetPageSize", default="100"))
        self.default_asset_max_pages = int(_config(self.config, "QUALYS_ASSET_MAX_PAGES", "assetMaxPages", default="5"))
        self.max_pages = int(_config(self.config, "QUALYS_MAX_PAGES", "maxPages", default="5"))
        self._jwt_token = None

    def list_hosts(self, truncation_limit=None, params=None, max_pages=None):
        request_params = _native_params({"action": "list"}, params)
        request_params["action"] = "list"
        if truncation_limit is not None or "truncation_limit" not in request_params:
            request_params["truncation_limit"] = str(truncation_limit or self.default_truncation_limit)
        return self._paginate_hosts(f"{self.vm_url}{HOST_LIST_ENDPOINT}", request_params, max_pages=max_pages)

    def list_assets(
        self,
        page_size=None,
        max_pages=None,
        detail_level="summary",
        include_fields=None,
        exclude_fields=None,
        asset_last_updated=None,
        filter_body=None,
        filter_xml=None,
        last_seen_asset_id=None,
    ):
        if include_fields:
            selected_fields = include_fields
        elif exclude_fields:
            selected_fields = None
        elif detail_level == "summary":
            selected_fields = ASSET_SUMMARY_FIELDS
        elif detail_level == "details":
            selected_fields = ASSET_DETAIL_FIELDS
        elif detail_level == "all":
            selected_fields = None
        else:
            raise QualysToolError("bad_arguments", "detail_level must be 'summary', 'details', or 'all'")
        assets, meta = self._fetch_gateway_assets(
            include_fields=selected_fields,
            exclude_fields=exclude_fields,
            page_size=page_size,
            max_pages=max_pages,
            asset_last_updated=asset_last_updated,
            filter_body=filter_body,
            filter_xml=filter_xml,
            last_seen_asset_id=last_seen_asset_id,
        )
        return {**meta, "results": assets}

    def count_assets(self, asset_last_updated=None, filter_body=None, filter_xml=None, last_seen_asset_id=None):
        params = {}
        if asset_last_updated:
            params["assetLastUpdated"] = asset_last_updated
        if last_seen_asset_id is not None:
            params["lastSeenAssetId"] = str(last_seen_asset_id)
        response = self._post_gateway_asset_search(
            f"{self.gateway_url}/rest/2.0/count/am/asset",
            params=params,
            filter_body=filter_body,
            filter_xml=filter_xml,
        )
        return {
            "response": response,
            "count": _safe_int(response.get("count")) if isinstance(response, dict) else None,
            "used_filter_body": bool(filter_body),
            "used_filter_xml": bool(filter_xml),
            "asset_last_updated": asset_last_updated,
            "last_seen_asset_id": last_seen_asset_id,
        }

    def _paginate_hosts(self, url, params, max_pages=None):
        max_pages = max_pages or self.max_pages
        if not isinstance(max_pages, int) or max_pages < 1:
            raise QualysToolError("bad_arguments", "max_pages must be a positive integer")
        records = []
        pages = 0
        next_url = None
        truncated = False
        while True:
            root = self._get_xml(next_url or url, params=None if next_url else params)
            for host_elem in root.findall(".//HOST"):
                records.append(_xml_to_obj(host_elem))
            pages += 1
            warning_url = _first_text(root, ".//WARNING/URL")
            if not warning_url:
                break
            if pages >= max_pages:
                truncated = True
                break
            next_url = warning_url
        return {"results": records, "truncated": truncated, "pages_fetched": pages}

    def _fetch_gateway_assets(
        self,
        include_fields,
        exclude_fields=None,
        page_size=None,
        max_pages=None,
        asset_last_updated=None,
        filter_body=None,
        filter_xml=None,
        last_seen_asset_id=None,
    ):
        page_size = page_size or self.default_asset_page_size
        max_pages = max_pages or self.default_asset_max_pages
        if not isinstance(page_size, int) or page_size < 1 or page_size > 100:
            raise QualysToolError("bad_arguments", "page_size must be between 1 and 100 for CSAM/GAV asset APIs")
        if not isinstance(max_pages, int) or max_pages < 1:
            raise QualysToolError("bad_arguments", "max_pages must be a positive integer")
        upstream_include_fields = _upstream_asset_field_names(include_fields)
        upstream_exclude_fields = _upstream_asset_field_names(exclude_fields)
        params = {"pageSize": str(page_size)}
        if upstream_include_fields:
            params["includeFields"] = ",".join(upstream_include_fields)
        if upstream_exclude_fields:
            params["excludeFields"] = ",".join(upstream_exclude_fields)
        if asset_last_updated:
            params["assetLastUpdated"] = asset_last_updated
        results = []
        pages = 0
        cursor = last_seen_asset_id
        truncated = False
        while True:
            page_params = dict(params)
            if cursor is not None:
                page_params["lastSeenAssetId"] = str(cursor)
            page = self._post_gateway_asset_search(
                f"{self.gateway_url}/rest/2.0/search/am/asset",
                params=page_params,
                filter_body=filter_body,
                filter_xml=filter_xml,
            )
            raw_assets = _asset_records(page)
            assets = [_project_asset_fields(asset, include_fields=include_fields, exclude_fields=exclude_fields) for asset in raw_assets]
            results.extend(assets)
            pages += 1
            cursor = _gateway_next_asset_cursor(page, raw_assets)
            has_more = _gateway_has_more(page, raw_assets, page_size, cursor)
            if not has_more:
                break
            if pages >= max_pages:
                truncated = True
                break
        return results, {
            "truncated": truncated,
            "pages_fetched": pages,
            "next_last_seen_asset_id": cursor if truncated else None,
            "used_filter_body": bool(filter_body),
            "used_filter_xml": bool(filter_xml),
            "include_fields": include_fields,
            "exclude_fields": exclude_fields,
            "upstream_include_fields": upstream_include_fields,
            "upstream_exclude_fields": upstream_exclude_fields,
            "asset_last_updated": asset_last_updated,
            "response_projection_applied": bool(include_fields or exclude_fields),
        }

    def _get_xml(self, url, params=None):
        full_url = f"{url}?{urlencode(params)}" if params else url
        req = Request(
            full_url,
            headers={
                **_browser_gate_headers(),
                "Authorization": self._auth_header(),
                "X-Requested-With": "curl",
                "Accept": "application/xml,text/xml,*/*",
            },
            method="GET",
        )
        body = self._request_bytes(req, "Qualys", parse_xml_cooldown=True)
        try:
            root = ET.fromstring(body)
        except ET.ParseError as exc:
            raise QualysToolError("upstream_error", f"Could not parse Qualys XML response: {exc}")
        if _strip_ns(root.tag) == "SIMPLE_RETURN":
            text = _first_text(root, ".//TEXT")
            raise QualysToolError("upstream_error", text or "Qualys returned an error with no TEXT element")
        return root

    def _post_form(self, url, data):
        req = Request(
            url,
            data=urlencode(data).encode(),
            headers={**_browser_gate_headers(), "Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        return self._request_bytes(req, "Qualys Gateway").decode("utf-8", errors="replace").strip()

    def _post_gateway_asset_search(self, url, params=None, filter_body=None, filter_xml=None):
        full_url = f"{url}?{urlencode(params)}" if params else url
        if filter_xml is not None:
            body = filter_xml.encode()
            content_type = "application/xml"
            accept = "application/xml,text/xml,application/json,*/*"
        else:
            body = json.dumps(filter_body or {}).encode()
            content_type = "application/json"
            accept = "application/json"
        req = Request(
            full_url,
            data=body,
            headers={
                **_browser_gate_headers(),
                "Authorization": f"Bearer {self._get_jwt()}",
                "Content-Type": content_type,
                "Accept": accept,
            },
            method="POST",
        )
        raw = self._request_bytes(req, "Qualys Gateway", return_error_body_codes=(400,)).decode("utf-8", errors="replace")
        stripped = raw.strip()
        if not stripped:
            raise QualysToolError("upstream_error", "Qualys Gateway returned an empty asset search response")
        if stripped.startswith("<"):
            try:
                parsed = _xml_to_obj(ET.fromstring(stripped))
            except ET.ParseError as exc:
                raise QualysToolError("upstream_error", f"Could not parse Qualys Gateway XML response: {exc}; first 300 chars: {raw[:300]}")
            payload = parsed if isinstance(parsed, dict) else {"response": parsed}
            _raise_gateway_failed_response(payload)
            return payload
        try:
            payload = json.loads(stripped)
        except json.JSONDecodeError as exc:
            raise QualysToolError("upstream_error", f"Could not parse Qualys Gateway JSON response: {exc}; first 300 chars: {raw[:300]}")
        _raise_gateway_failed_response(payload)
        return payload

    def _get_jwt(self):
        if self._jwt_token:
            return self._jwt_token
        if not self.gateway_url:
            raise QualysToolError("missing_config", "QUALYS_GATEWAY_URL is not set and could not be derived from QUALYS_VM_URL")
        token = self._post_form(
            f"{self.gateway_url}/auth",
            {"username": self.username, "password": self.password, "token": "true"},
        )
        if not token:
            raise QualysToolError("auth_failed", "Qualys Gateway /auth returned an empty token")
        if token.startswith("<") or "html" in token.lower():
            raise QualysToolError("auth_failed", f"Qualys Gateway /auth did not return a raw JWT token: {token[:300]}")
        self._jwt_token = token
        return token

    def _auth_header(self):
        basic = base64.b64encode(f"{self.username}:{self.password}".encode()).decode()
        return f"Basic {basic}"

    def _ssl_context(self):
        return ssl.create_default_context() if self.verify_tls else ssl._create_unverified_context()

    def _request_bytes(self, req, service, parse_xml_cooldown=False, return_error_body_codes=None):
        try:
            with urlopen(req, timeout=self.timeout, context=self._ssl_context()) as resp:
                body = resp.read()
        except HTTPError as exc:
            body = exc.read()
            body_txt = body.decode("utf-8", errors="replace")
            if return_error_body_codes and exc.code in return_error_body_codes:
                return body
            if exc.code in (401, 403):
                if "Gateway" in service:
                    self._jwt_token = None
                raise QualysToolError("auth_failed", f"{service} HTTP {exc.code}: {body_txt[:500]}")
            if exc.code in (409, 429):
                raise QualysToolError("rate_limited", f"{service} HTTP {exc.code}: {body_txt[:500]}")
            raise QualysToolError("upstream_error", f"{service} HTTP {exc.code}: {body_txt[:500]}")
        except URLError as exc:
            raise QualysToolError("connection_error", f"{service} connection error: {exc}")
        if parse_xml_cooldown:
            cooldown = _qualys_cooldown_seconds_from_text(body.decode("utf-8", errors="replace"))
            if cooldown is not None:
                raise QualysToolError("rate_limited", "Qualys returned cooldown CODE 1965; retry later or lower page sizes.")
        return body


def _list_assets_from_args(client, args):
    _validate_gateway_page_size(args)
    _validate_positive(args, "max_pages")
    _validate_positive(args, "last_seen_asset_id")
    detail_level = args.get("detail_level", "summary")
    include_fields = args.get("include_fields")
    exclude_fields = args.get("exclude_fields")
    _validate_string_list(include_fields, "include_fields")
    _validate_string_list(exclude_fields, "exclude_fields")
    if include_fields is not None and exclude_fields is not None:
        raise QualysToolError("bad_arguments", "Use include_fields or exclude_fields, not both")
    if exclude_fields is not None and args.get("detail_level") not in (None, "all"):
        raise QualysToolError("bad_arguments", "exclude_fields uses Qualys default All fields; omit detail_level or set detail_level='all'")
    return client.list_assets(
        page_size=args.get("page_size"),
        max_pages=args.get("max_pages"),
        detail_level=detail_level,
        include_fields=include_fields,
        exclude_fields=exclude_fields,
        asset_last_updated=_optional_string(args, "asset_last_updated"),
        filter_body=_gateway_filter_body_arg(args, allow_filter_xml=True),
        filter_xml=_gateway_filter_xml_arg(args),
        last_seen_asset_id=args.get("last_seen_asset_id"),
    )


def _qagent_filter_body(args):
    if args.get("filter_xml") is not None:
        raise QualysToolError("bad_arguments", "cloud agent hostasset tools require JSON filter_body/search_body so asset.trackingMethod EQUALS QAGENT can be applied")
    base = _gateway_filter_body_arg(args, allow_filter_xml=False) or {"filters": []}
    filters = [item for item in base.get("filters", []) if isinstance(item, dict)]
    operation = str(base.get("operation") or "AND").upper()
    if operation != "AND":
        raise QualysToolError("bad_arguments", "cloud agent hostasset tools always AND caller filters with asset.trackingMethod EQUALS QAGENT; use qualys_gav_asset_count for other boolean operations")
    for item in filters:
        if str(item.get("field", "")).lower() != "asset.trackingmethod":
            continue
        if str(item.get("operator", "")).upper() == "EQUALS" and str(item.get("value", "")).upper() == "QAGENT":
            return {**base, "operation": "AND", "filters": filters}
        raise QualysToolError("bad_arguments", "cloud agent hostasset tools require asset.trackingMethod EQUALS QAGENT; omit trackingMethod or use qualys_gav_asset_count")
    return {**base, "operation": "AND", "filters": [QAGENT_FILTER] + filters}


def _validate_host_list_args(args):
    if "tracking_method" in args or "trackingMethod" in args:
        raise QualysToolError("bad_arguments", "tracking_method is not a documented Qualys Host List input filter; inspect output fields instead")
    params = args.get("params") or {}
    if any(str(key).lower() in {"tracking_method", "trackingmethod"} for key in params):
        raise QualysToolError("bad_arguments", "trackingMethod/tracking_method is not a documented Qualys Host List input filter; inspect output fields instead")


def _config(config, *names, default="", required=False):
    for name in names:
        value = config.get(name)
        if value is not None and str(value).strip():
            return str(value).strip()
    if required:
        raise QualysToolError("missing_config", f"{names[0]} is required")
    return default


def _secret(secrets, *names, required=False):
    for name in names:
        value = secrets.get(name)
        if value is not None and str(value).strip():
            return str(value).strip()
    if required:
        raise QualysToolError("missing_config", f"{names[0]} is required")
    return ""


def _browser_gate_headers():
    return {"User-Agent": "curl/8.5.0", "Connection": "close"}


def _derive_gateway_url(vm_url):
    if not vm_url:
        return ""
    parsed = urlparse(vm_url)
    host = parsed.netloc
    if host.startswith("qualysguard."):
        host = "gateway." + host[len("qualysguard.") :]
    else:
        return ""
    return urlunparse((parsed.scheme, host, "", "", "", ""))


def _native_params(defaults=None, params=None):
    merged = dict(defaults or {})
    for key, value in (params or {}).items():
        if value is not None:
            merged[str(key)] = value
    return merged


def _native_params_arg(args, required=False):
    params = args.get("params")
    if required and not params:
        raise QualysToolError("bad_arguments", "params is required")
    _validate_mapping(params, "params")
    if params is None:
        return None
    for key, value in params.items():
        if not isinstance(key, str) or not key.strip():
            raise QualysToolError("bad_arguments", "params keys must be non-empty strings")
        if not isinstance(value, (str, int, float, bool)):
            raise QualysToolError("bad_arguments", "params values must be string, number, or boolean")
    return params


def _gateway_filter_body_arg(args, allow_filter_xml=False):
    search_body = _normalize_gateway_filter_body(args.get("search_body"))
    filter_body = _normalize_gateway_filter_body(args.get("filter_body"))
    _validate_mapping(search_body, "search_body")
    _validate_mapping(filter_body, "filter_body")
    _validate_gateway_filter_shape(search_body, "search_body")
    _validate_gateway_filter_shape(filter_body, "filter_body")
    if search_body is not None and filter_body is not None:
        raise QualysToolError("bad_arguments", "Use filter_body or search_body, not both")
    if args.get("filter_xml") is not None:
        if not allow_filter_xml:
            raise QualysToolError("bad_arguments", "filter_xml is only supported by qualys_gav_asset_search and qualys_gav_asset_count")
        if search_body is not None or filter_body is not None:
            raise QualysToolError("bad_arguments", "Use filter_xml or JSON filter_body/search_body, not both")
    return filter_body if filter_body is not None else search_body


def _gateway_filter_xml_arg(args):
    value = args.get("filter_xml")
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise QualysToolError("bad_arguments", "filter_xml must be a non-empty string")
    return value.strip()


def _raise_gateway_failed_response(payload):
    if not isinstance(payload, dict):
        return
    response_code = str(payload.get("responseCode") or "").upper()
    if not response_code or response_code == "SUCCESS":
        return
    message = str(payload.get("responseMessage") or "Qualys Gateway returned a failed response")
    error_code = "bad_arguments" if "Request Validation Exception" in message else "upstream_error"
    raise QualysToolError(error_code, f"Qualys Gateway {response_code}: {message[:1200]}")


def _normalize_gateway_filter_body(value):
    if not isinstance(value, dict):
        return value
    service_request = value.get("ServiceRequest")
    if not isinstance(service_request, dict):
        return value
    filters = service_request.get("filters")
    if isinstance(filters, list):
        return {"filters": filters}
    if isinstance(filters, dict) and "Criteria" in filters:
        criteria = filters.get("Criteria")
        if isinstance(criteria, list):
            return {"filters": criteria}
        if isinstance(criteria, dict):
            return {"filters": [criteria]}
    return value


def _validate_gateway_filter_shape(value, field):
    if value is None or value == {}:
        return
    if any(key in value for key in ("field", "operator", "value")):
        raise QualysToolError("bad_arguments", f"{field} must be a FilterRequest object with a filters array; do not pass a bare Criteria object")
    filters = value.get("filters")
    if not isinstance(filters, list) or not filters:
        raise QualysToolError("bad_arguments", f"{field}.filters must be a non-empty array of Criteria objects")
    for index, criterion in enumerate(filters):
        if not isinstance(criterion, dict):
            raise QualysToolError("bad_arguments", f"{field}.filters[{index}] must be an object")
        if not isinstance(criterion.get("field"), str) or not criterion.get("field").strip():
            raise QualysToolError("bad_arguments", f"{field}.filters[{index}].field must be a non-empty string")
        normalized_filter_field = criterion.get("field").strip().lower()
        if normalized_filter_field in {"asset_last_updated", "assetlastupdated", "last_seen_asset_id", "lastseenassetid"}:
            raise QualysToolError("bad_arguments", f"{field}.filters[{index}].field={criterion.get('field')} is a hosted tool request parameter, not a Qualys GAV filter field; pass it as a top-level argument instead")
        if not isinstance(criterion.get("operator"), str) or not criterion.get("operator").strip():
            raise QualysToolError("bad_arguments", f"{field}.filters[{index}].operator must be a non-empty string")
        if "value" not in criterion:
            raise QualysToolError("bad_arguments", f"{field}.filters[{index}].value is required")


def _validate_mapping(value, field):
    if value is not None and not isinstance(value, dict):
        raise QualysToolError("bad_arguments", f"{field} must be an object")


def _validate_positive(args, field):
    value = args.get(field)
    if value is not None and (not isinstance(value, int) or value < 1):
        raise QualysToolError("bad_arguments", f"{field} must be a positive integer")


def _positive_int(args, field):
    _validate_positive(args, field)
    return args.get(field)


def _validate_gateway_page_size(args):
    _validate_positive(args, "page_size")
    value = args.get("page_size")
    if value is not None and value > 100:
        raise QualysToolError("bad_arguments", "page_size must be between 1 and 100 for CSAM/GAV asset APIs")


def _optional_string(args, field):
    value = args.get(field)
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise QualysToolError("bad_arguments", f"{field} must be a non-empty string")
    return value.strip()


def _validate_string_list(value, field):
    if value is not None and (not isinstance(value, list) or not all(isinstance(item, str) and item.strip() for item in value)):
        raise QualysToolError("bad_arguments", f"{field} must be an array of non-empty strings")


def _strip_ns(tag):
    return tag.split("}", 1)[-1] if "}" in tag else tag


def _xml_to_obj(elem):
    children = list(elem)
    if not children:
        return (elem.text or "").strip()
    grouped = {}
    for child in children:
        grouped.setdefault(_strip_ns(child.tag), []).append(_xml_to_obj(child))
    return {key: (value[0] if len(value) == 1 else value) for key, value in grouped.items()}


def _first_text(root, path):
    elem = root.find(path)
    if elem is None or elem.text is None:
        return None
    text = elem.text.strip()
    return text or None


def _qualys_cooldown_seconds_from_text(text):
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return None
    if _first_text(root, ".//CODE") != "1965":
        return None
    message = _first_text(root, ".//TEXT") or ""
    match = re.search(r"another\s+(\d+)\s+minutes?\s+and\s+(\d+)\s+seconds?", message, re.I)
    if match:
        return int(match.group(1)) * 60 + int(match.group(2))
    return None


def _asset_records(payload):
    for key in ("assetListData", "assets", "data"):
        value = payload.get(key)
        if isinstance(value, dict):
            for nested in ("asset", "assets"):
                records = value.get(nested)
                if isinstance(records, list):
                    return [record for record in records if isinstance(record, dict)]
                if isinstance(records, dict):
                    return [records]
        if isinstance(value, list):
            return [record for record in value if isinstance(record, dict)]
    if isinstance(payload.get("asset"), list):
        return [record for record in payload["asset"] if isinstance(record, dict)]
    if isinstance(payload.get("asset"), dict):
        return [payload["asset"]]
    return []


def _asset_field_key_set(fields):
    keys = set()
    for field in fields or []:
        raw = field.strip()
        keys.add(raw)
        keys.update(ASSET_FIELD_ALIASES.get(raw.lower(), []))
    return keys


def _upstream_asset_field_names(fields):
    allowed = set(GAV_INCLUDE_EXCLUDE_FIELDS)
    normalized = []
    for field in fields or []:
        raw = field.strip()
        if not raw:
            continue
        canonical = raw if raw in allowed else GAV_INCLUDE_FIELD_ALIASES.get(raw.lower())
        if canonical in allowed and canonical not in normalized:
            normalized.append(canonical)
    return normalized


def _project_asset_fields(asset, include_fields=None, exclude_fields=None):
    if include_fields:
        keys = _asset_field_key_set(include_fields)
        return {key: value for key, value in asset.items() if key in keys}
    if exclude_fields:
        keys = _asset_field_key_set(exclude_fields)
        return {key: value for key, value in asset.items() if key not in keys}
    return asset


def _last_asset_id(assets):
    for asset in reversed(assets):
        raw = asset.get("assetId") or asset.get("hostId") or asset.get("id")
        try:
            return int(raw)
        except (TypeError, ValueError):
            continue
    return None


def _gateway_next_asset_cursor(page, assets):
    for key in ("lastSeenAssetId", "last_seen_asset_id"):
        cursor = _safe_int(page.get(key))
        if cursor is not None:
            return cursor
    return _last_asset_id(assets)


def _gateway_has_more(page, assets, page_size, cursor):
    for key in ("hasMore", "has_more"):
        if key in page:
            value = page.get(key)
            if isinstance(value, bool):
                return value and cursor is not None
            if _safe_int(value) is not None:
                return bool(_safe_int(value)) and cursor is not None
    return bool(assets) and len(assets) >= page_size and cursor is not None


def _safe_int(value):
    try:
        if value is None or value == "":
            return None
        return int(value)
    except (TypeError, ValueError):
        return None
`;
}
