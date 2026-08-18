export const LEGACY_INTEGRATION_HUB_QUALYS_SOURCE_PATH =
  "tmp/openacme-realdata-test-20260724-103001/agents/mcp-server-admin-and-developer/workspace/src/integration_hub/integrations/qualys";

export function qualysCurrentPromotedReadOnlySourceBackedFamilyYaml(): string {
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
    errors:
      - bad_arguments means the request shape or filter token is unsupported; fix the input before retrying.
      - auth_failed means Qualys credentials or endpoint config are missing or invalid.
      - upstream_error or rate_limited means Qualys rejected the request; retry only when the error says it is safe.
      - connection_error means the network request failed before Qualys returned a usable response; retry only after checking endpoint connectivity.
${qualysGavAssetCountHelpYaml()}
  - name: qualys_gav_asset_get
    title: Qualys GAV Asset Get
    description: Source-backed direct Qualys GAV asset detail lookup for one known asset_id through GET /rest/2.0/get/am/asset. Use this when the asset id is already known; discover the id first with qualys_gav_asset_search when needed.
    inputSchema:
      type: object
      properties:
        asset_id:
          type: integer
          description: Required Qualys GAV assetId for a single direct asset detail lookup.
        include_fields:
          type: array
          items:
            type: string
        exclude_fields:
          type: array
          items:
            type: string
      required:
        - asset_id
      additionalProperties: false
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
    errors:
      - bad_arguments means asset_id is missing/invalid or include/exclude projection fields conflict; fix the input before retrying.
      - auth_failed means Qualys credentials or endpoint config are missing or invalid.
      - upstream_error or rate_limited means Qualys rejected the request; retry only when the error says it is safe.
      - connection_error means the network request failed before Qualys returned a usable response; retry only after checking endpoint connectivity.
${qualysGavAssetGetHelpYaml()}
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
    errors:
      - bad_arguments means the request shape, projection fields, or filter token is unsupported; fix the input before retrying.
      - auth_failed means Qualys credentials or endpoint config are missing or invalid.
      - upstream_error or rate_limited means Qualys rejected the request; reduce page_size/max_pages or retry only when safe.
      - connection_error means the network request failed before Qualys returned a usable response; retry only after checking endpoint connectivity.
    pagination:
      model: lastSeenAssetId
      limitArgs: [page_size, max_pages]
      continuation: last_seen_asset_id
      truncation: max_pages stops pagination before all records are exhausted.
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
    errors:
      - bad_arguments means the request shape, Cloud Agent scope, or filter token is unsupported; fix the input before retrying.
      - auth_failed means Qualys credentials or endpoint config are missing or invalid.
      - upstream_error or rate_limited means Qualys rejected the request; retry only when the error says it is safe.
      - connection_error means the network request failed before Qualys returned a usable response; retry only after checking endpoint connectivity.
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
    errors:
      - bad_arguments means the request shape, Cloud Agent scope, projection fields, or filter token is unsupported; fix the input before retrying.
      - auth_failed means Qualys credentials or endpoint config are missing or invalid.
      - upstream_error or rate_limited means Qualys rejected the request; reduce page_size/max_pages or retry only when safe.
      - connection_error means the network request failed before Qualys returned a usable response; retry only after checking endpoint connectivity.
    pagination:
      model: lastSeenAssetId
      limitArgs: [page_size, max_pages]
      continuation: last_seen_asset_id
      truncation: max_pages stops pagination before all records are exhausted.
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
    errors:
      - bad_arguments means unsupported VMDR Host List params were supplied; remove tracking_method/trackingMethod before retrying.
      - auth_failed means Qualys credentials or endpoint config are missing or invalid.
      - upstream_error or rate_limited means Qualys rejected the request; reduce truncation_limit/max_pages or retry only when safe.
      - connection_error means the network request failed before Qualys returned a usable response; retry only after checking endpoint connectivity.
    pagination:
      model: foWarningUrl
      limitArgs: [truncation_limit, max_pages]
      continuation: warning_url
      truncation: max_pages stops following Qualys warning URLs.
${qualysVmdrHostListHelpYaml()}
  - name: qualys_vmdr_host_detection_list
    title: Qualys VMDR Host Detection List
    description: Source-backed Qualys VMDR Host Detection read for host+QID detection evidence through GET /api/2.0/fo/asset/host/vm/detection/. Use top-level status for current detection state and params.qids for QID filters; do not send params.status or params.qid.
    inputSchema:
      type: object
      properties:
        status:
          type: string
          description: Optional current detection status list such as New,Active,Re-Opened. Omitted status defaults to current vulnerable detections.
        params:
          type: object
          description: Native Qualys Host Detection query parameters such as qids, ids, ips, severities, qds_min, qds_max, show_qds, show_qds_factors, include_vuln_type, show_asset_id, and detection_updated_since. Do not include status or qid here.
          additionalProperties: true
        truncation_limit:
          type: integer
        max_pages:
          type: integer
      additionalProperties: false
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
    errors:
      - bad_arguments means unsupported Host Detection params were supplied; use top-level status, plural params.qids, positive truncation_limit/max_pages, and XML output only.
      - auth_failed means Qualys credentials or endpoint config are missing or invalid.
      - upstream_error or rate_limited means Qualys rejected the request; reduce truncation_limit/max_pages or retry only when safe.
      - connection_error means the network request failed before Qualys returned a usable response; retry only after checking endpoint connectivity.
    pagination:
      model: foWarningUrl
      limitArgs: [truncation_limit, max_pages]
      continuation: warning_url
      truncation: max_pages stops following Qualys warning URLs.
${qualysVmdrHostDetectionListHelpYaml()}
  - name: qualys_vmdr_asset_group_list
    title: Qualys VMDR Asset Group List
    description: Source-backed Qualys VMDR Asset Group List read through GET /api/2.0/fo/asset/group/?action=list. Use native params such as ids and max_pages for FO warning URL pagination; returns ASSET_GROUP records.
    inputSchema:
      type: object
      properties:
        params:
          type: object
          description: Native Qualys Asset Group List action=list query parameters such as ids. Do not invent unsupported text-search or tag filters.
          additionalProperties: true
        max_pages:
          type: integer
          description: Positive page cap for following Qualys FO warning URLs; use 1 for bounded live probes.
      additionalProperties: false
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
    errors:
      - bad_arguments means unsupported Asset Group List params or pagination controls were supplied; fix params before retrying.
      - auth_failed means Qualys credentials or endpoint config are missing or invalid.
      - upstream_error or rate_limited means Qualys rejected the request; reduce max_pages or retry only when safe.
      - connection_error means the network request failed before Qualys returned a usable response; retry only after checking endpoint connectivity.
    pagination:
      model: foWarningUrl
      limitArgs: [max_pages]
      continuation: warning_url
      truncation: max_pages stops following Qualys warning URLs.
${qualysVmdrAssetGroupListHelpYaml()}
  - name: qualys_vmdr_ip_list
    title: Qualys VMDR IP List
    description: Source-backed Qualys VMDR IP/range inventory read through GET /api/2.0/fo/asset/ip/?action=list. Use native params such as ips and max_pages for FO warning URL pagination; returns IP/RANGE records.
    inputSchema:
      type: object
      properties:
        params:
          type: object
          description: Native Qualys IP List action=list query parameters such as ips. Do not invent GAV filter_body or Asset Group params.
          additionalProperties: true
        max_pages:
          type: integer
          description: Positive page cap for following Qualys FO warning URLs; use 1 for bounded live probes.
      additionalProperties: false
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
    errors:
      - bad_arguments means unsupported IP List params or pagination controls were supplied; fix params before retrying.
      - auth_failed means Qualys credentials or endpoint config are missing or invalid.
      - upstream_error or rate_limited means Qualys rejected the request; reduce max_pages or retry only when safe.
      - connection_error means the network request failed before Qualys returned a usable response; retry only after checking endpoint connectivity.
    pagination:
      model: foWarningUrl
      limitArgs: [max_pages]
      continuation: warning_url
      truncation: max_pages stops following Qualys warning URLs.
${qualysVmdrIpListHelpYaml()}
  - name: qualys_vmdr_excluded_ip_list
    title: Qualys VMDR Excluded IP List
    description: Source-backed Qualys VMDR excluded IP/range inventory read through GET /api/2.0/fo/asset/excluded_ip/?action=list. Use native params such as ips and max_pages for FO warning URL pagination; returns excluded IP/range records.
    inputSchema:
      type: object
      properties:
        params:
          type: object
          description: Native Qualys Excluded IP List action=list query parameters such as ips. Do not invent GAV filter_body, Asset Group params, or included-IP endpoint params.
          additionalProperties: true
        max_pages:
          type: integer
          description: Positive page cap for following Qualys FO warning URLs; use 1 for bounded live probes.
      additionalProperties: false
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
    errors:
      - bad_arguments means unsupported Excluded IP List params or pagination controls were supplied; fix params before retrying.
      - auth_failed means Qualys credentials or endpoint config are missing or invalid.
      - upstream_error or rate_limited means Qualys rejected the request; reduce max_pages or retry only when safe.
      - connection_error means the network request failed before Qualys returned a usable response; retry only after checking endpoint connectivity.
    pagination:
      model: foWarningUrl
      limitArgs: [max_pages]
      continuation: warning_url
      truncation: max_pages stops following Qualys warning URLs.
${qualysVmdrExcludedIpListHelpYaml()}
  - name: qualys_vmdr_restricted_ip_list
    title: Qualys VMDR Restricted IP List
    description: Source-backed Qualys VMDR restricted IP/range inventory read through GET /api/2.0/fo/setup/restricted_ips/?action=list&output_format=xml. Use native params and max_pages for FO warning URL pagination; returns restricted IP/range records.
    inputSchema:
      type: object
      properties:
        params:
          type: object
          description: Native Qualys Restricted IP List action=list query parameters. The tool enforces output_format=xml. Do not invent GAV filter_body, Asset Group params, or included/excluded-IP endpoint params.
          additionalProperties: true
        max_pages:
          type: integer
          description: Positive page cap for following Qualys FO warning URLs; use 1 for bounded live probes.
      additionalProperties: false
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
    errors:
      - bad_arguments means unsupported Restricted IP List params or pagination controls were supplied; fix params before retrying.
      - auth_failed means Qualys credentials or endpoint config are missing or invalid.
      - upstream_error or rate_limited means Qualys rejected the request; reduce max_pages or retry only when safe.
      - connection_error means the network request failed before Qualys returned a usable response; retry only after checking endpoint connectivity.
    pagination:
      model: foWarningUrl
      limitArgs: [max_pages]
      continuation: warning_url
      truncation: max_pages stops following Qualys warning URLs.
${qualysVmdrRestrictedIpListHelpYaml()}
  - name: qualys_vmdr_virtual_host_list
    title: Qualys VMDR Virtual Host List
    description: Source-backed Qualys VMDR virtual host inventory read through GET /api/2.0/fo/asset/vhost/?action=list. Use native params and max_pages for FO warning URL pagination; returns VIRTUAL_HOST records.
    inputSchema:
      type: object
      properties:
        params:
          type: object
          description: Native Qualys Virtual Host List action=list query parameters. Do not invent GAV filter_body, VMDR Host List params, or IP scope params.
          additionalProperties: true
        max_pages:
          type: integer
          description: Positive page cap for following Qualys FO warning URLs; use 1 for bounded live probes.
      additionalProperties: false
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
    errors:
      - bad_arguments means unsupported Virtual Host List params or pagination controls were supplied; fix params before retrying.
      - auth_failed means Qualys credentials or endpoint config are missing or invalid.
      - upstream_error or rate_limited means Qualys rejected the request; reduce max_pages or retry only when safe.
      - connection_error means the network request failed before Qualys returned a usable response; retry only after checking endpoint connectivity.
    pagination:
      model: foWarningUrl
      limitArgs: [max_pages]
      continuation: warning_url
      truncation: max_pages stops following Qualys warning URLs.
${qualysVmdrVirtualHostListHelpYaml()}
  - name: qualys_vmdr_scan_list
    title: Qualys VMDR Scan List
    description: Source-backed Qualys VMDR scan listing through GET /api/2.0/fo/scan/?action=list. Use native params and max_pages for FO warning URL pagination; returns SCAN records and does not fetch scan result payloads.
    inputSchema:
      type: object
      properties:
        params:
          type: object
          description: Native Qualys VM scan list action=list query parameters such as launched_after_datetime or state. Do not pass scan_ref; use qualys_vmdr_scan_fetch for a known scan_ref payload.
          additionalProperties: true
        max_pages:
          type: integer
          description: Positive page cap for following Qualys FO warning URLs; use 1 for bounded live probes.
      additionalProperties: false
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
    errors:
      - bad_arguments means unsupported VMDR Scan List params or pagination controls were supplied; fix params before retrying.
      - auth_failed means Qualys credentials or endpoint config are missing or invalid.
      - upstream_error or rate_limited means Qualys rejected the request; reduce max_pages or retry only when safe.
      - connection_error means the network request failed before Qualys returned a usable response; retry only after checking endpoint connectivity.
    pagination:
      model: foWarningUrl
      limitArgs: [max_pages]
      continuation: warning_url
      truncation: max_pages stops following Qualys warning URLs.
${qualysVmdrScanListHelpYaml()}
  - name: qualys_vmdr_scan_fetch
    title: Qualys VMDR Scan Fetch
    description: Source-backed Qualys VMDR scan result payload fetch through GET /api/2.0/fo/scan/?action=fetch for a discovered scan_ref. Use after qualys_vmdr_scan_list; fetch output can be large and should be treated as an artifact candidate.
    inputSchema:
      type: object
      properties:
        scan_ref:
          type: string
          description: Required Qualys scan_ref discovered from qualys_vmdr_scan_list. Do not pass placeholders or guessed refs.
        params:
          type: object
          description: Optional native Qualys scan fetch params such as ips, mode, or output_format. action=fetch and scan_ref are enforced by the hosted tool.
          additionalProperties: true
      required:
        - scan_ref
      additionalProperties: false
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
    errors:
      - bad_arguments means scan_ref is missing, placeholder-like, or unsupported fetch params/request controls were supplied; discover a real scan_ref first.
      - auth_failed means Qualys credentials or endpoint config are missing or invalid.
      - upstream_error or rate_limited means Qualys rejected the request; retry only when safe or narrow fetch params such as ips/mode/output_format.
      - connection_error means the network request failed before Qualys returned a usable response; retry only after checking endpoint connectivity.
    pagination:
      model: none
      limitArgs: []
      continuation: none
      truncation: Fetch returns one scan result payload; large responses are handled by the hosted response artifact choke point.
${qualysVmdrScanFetchHelpYaml()}
  - name: qualys_vmdr_kb_vuln_list
    title: Qualys VMDR KnowledgeBase Vulnerability List
    description: Source-backed Qualys VMDR KnowledgeBase vulnerability metadata lookup through POST /api/2.0/fo/knowledge_base/vuln/. Use this for QID/CVE metadata resolution; it is metadata only and does not prove tenant exposure.
    inputSchema:
      type: object
      properties:
        params:
          type: object
          description: Required native Qualys KnowledgeBase action=list parameters such as ids, cve, details, published_after, last_modified_after, is_patchable, show_qid_change_log, or show_supported_modules_info. Do not include page_size or Host Detection parameters.
          additionalProperties: true
        max_pages:
          type: integer
          description: Positive page cap for following Qualys FO warning URLs; use 1 for bounded live probes.
      required:
        - params
      additionalProperties: false
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
    errors:
      - bad_arguments means required params are missing or unsupported KB params/request controls were supplied; fix the input before retrying.
      - auth_failed means Qualys credentials or endpoint config are missing or invalid.
      - upstream_error or rate_limited means Qualys rejected the request; reduce max_pages or retry only when safe.
      - connection_error means the network request failed before Qualys returned a usable response; retry only after checking endpoint connectivity.
    pagination:
      model: foWarningUrl
      limitArgs: [max_pages]
      continuation: warning_url
      truncation: max_pages stops following Qualys warning URLs.
${qualysVmdrKbVulnListHelpYaml()}
  - name: qualys_vmdr_kb_qvs_list
    title: Qualys VMDR KnowledgeBase QVS List
    description: Source-backed Qualys VMDR QVS metadata lookup through /api/3.0/fo/knowledge_base/qvs/?action=list. Use this for CVE/vulnerability-level QVS enrichment; it is not Host Detection QDS and does not prove tenant exposure.
    inputSchema:
      type: object
      properties:
        params:
          type: object
          description: Required native Qualys QVS action=list parameters with a bounded filter such as cve, qvs_min/qvs_max, qvs_last_modified_after, or nvd_published_after. Do not include page_size or Host Detection QDS parameters.
          additionalProperties: true
      required:
        - params
      additionalProperties: false
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
    errors:
      - bad_arguments means required params are missing, unbounded, or unsupported QVS params/request controls were supplied; fix the input before retrying.
      - auth_failed means Qualys credentials or endpoint config are missing or invalid.
      - upstream_error or rate_limited means Qualys rejected the request; narrow params or retry only when safe.
      - connection_error means the network request failed before Qualys returned a usable response; retry only after checking endpoint connectivity.
    pagination:
      model: boundedParams
      limitArgs: [params.cve, params.qvs_min, params.qvs_max, params.qvs_last_modified_after, params.nvd_published_after]
      continuation: none
      truncation: The tool requires bounded params and does not expose page_size or truncation_limit.
${qualysVmdrKbQvsListHelpYaml()}
  - name: qualys_asset_management_tag_list
    title: Qualys Asset Management Tag List
    description: Source-backed Qualys Asset Management tag listing through POST /qps/rest/2.0/search/am/tag using QPS ServiceRequest XML and optional limitResults. Use this for bounded read-only all-tag pulls; it returns ServiceResponse.data.Tag records and intentionally accepts only limit.
    inputSchema:
      type: object
      properties:
        limit:
          type: integer
          description: Optional positive QPS preferences.limitResults cap.
      additionalProperties: false
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
    errors:
      - bad_arguments means unsupported filter/search arguments were supplied or limit is not a positive integer.
      - auth_failed means Qualys credentials or endpoint config are missing or invalid.
      - upstream_error or rate_limited means Qualys rejected the QPS request; reduce limit or retry only when safe.
      - connection_error means the network request failed before Qualys returned a usable response; retry only after checking endpoint connectivity.
    pagination:
      model: qpsLimitResults
      limitArgs: [limit]
      continuation: none
      truncation: limitResults bounds returned ServiceResponse.data.Tag records.
${qualysAssetManagementTagListHelpYaml()}
  - name: qualys_asset_management_tag_search
    title: Qualys Asset Management Tag Search
    description: Source-backed Qualys Asset Management tag search through POST /qps/rest/2.0/search/am/tag using QPS ServiceRequest XML Criteria. Use this for read-only tag record discovery; it returns ServiceResponse.data.Tag records and is not a GAV asset search.
    inputSchema:
      type: object
      properties:
        criteria:
          type: array
          description: Required QPS ServiceRequest filters.Criteria array. Each item becomes a Criteria element with field, operator, and value attributes/text.
          items:
            type: object
            properties:
              field:
                type: string
              operator:
                type: string
              value:
                type: string
            required:
              - field
              - operator
              - value
            additionalProperties: false
        limit:
          type: integer
          description: Optional positive QPS preferences.limitResults cap.
      required:
        - criteria
      additionalProperties: false
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
    errors:
      - bad_arguments means criteria is missing, empty, wildcard-only, or not shaped as QPS Criteria field/operator/value entries.
      - auth_failed means Qualys credentials or endpoint config are missing or invalid.
      - upstream_error or rate_limited means Qualys rejected the QPS request; narrow criteria or retry only when safe.
      - connection_error means the network request failed before Qualys returned a usable response; retry only after checking endpoint connectivity.
    pagination:
      model: qpsLimitResults
      limitArgs: [limit]
      continuation: none
      truncation: limitResults bounds returned ServiceResponse.data.Tag records.
${qualysAssetManagementTagSearchHelpYaml()}
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
          vocabularyRef: references/gav-filter-fields.json
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
        filter_body.filters.field:
          summary: Native Qualys GAV filter token.
          full: Use asset.name, operatingSystem.category1, operatingSystem.category2, software.name, qualys.agent.lastCheckedInDate, asset.trackingMethod, or another documented GAV token. Do not use response projection fields such as assetName.
          vocabularyRef: references/gav-filter-fields.json
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

function qualysGavAssetGetHelpYaml(): string {
  return `
    help:
      summary: Fetch one known CSAM/GAV asset by Qualys asset_id.
      full: |
        Calls the direct Qualys Gateway GET /rest/2.0/get/am/asset endpoint
        for a single known asset id. Use this when the caller already has a
        stable GAV assetId or has just discovered one through a bounded GAV
        asset search. Do not run a broad search only to fetch details for an
        already-known asset id.
      whenToUse:
        - Retrieve detailed GAV asset context for one known asset_id.
        - Enrich a VMDR or inventory workflow after preserving the exact GAV assetId.
      whenNotToUse:
        - Do not use when the asset id is unknown; discover it with qualys_gav_asset_search first.
        - Do not pass multiple ids or the legacy asset_ids array.
      parameters:
        asset_id:
          summary: Required single Qualys GAV assetId.
          full: Numeric asset id sent to Qualys as assetId on GET /rest/2.0/get/am/asset. The focused hosted tool accepts one asset_id per call, not asset_ids.
        include_fields:
          summary: Optional response field projection list for the returned asset.
          full: List response projection fields to keep, such as assetId, assetName, address, operatingSystem, agent, agentId, or tag. Do not combine with exclude_fields.
        exclude_fields:
          summary: Optional response field exclusion list for the returned asset.
          full: List response projection fields to omit. Do not combine with include_fields.
      examples:
        - asset_id: 1
          include_fields:
            - assetId
            - assetName
            - operatingSystem
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
          vocabularyRef: references/gav-filter-fields.json
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
        filter_body.filters.field:
          summary: Native Qualys GAV filter token.
          full: Use asset.name, operatingSystem.category1, operatingSystem.category2, software.name, qualys.agent.lastCheckedInDate, asset.trackingMethod, or another documented GAV token. Do not use response projection fields such as assetName.
          vocabularyRef: references/gav-filter-fields.json
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

function qualysVmdrHostDetectionListHelpYaml(): string {
  return `
    help:
      summary: List VMDR host vulnerability detections through GET /api/2.0/fo/asset/host/vm/detection/ with top-level status and params.qids.
      full: |
        Calls the Qualys VMDR Host Detection endpoint
        GET /api/2.0/fo/asset/host/vm/detection/ and returns host records with
        host+QID detection evidence such as QIDs, current status, detection
        dates, and optional QDS fields when requested. Use this for tenant exposure facts:
        one returned host may contain multiple detection records. Do not use
        this as a vulnerability catalog or CVE/QVS lookup; resolve CVE/QID
        through source-backed KB tools before querying host evidence.
      whenToUse:
        - Retrieve host+QID detection evidence for known QIDs, hosts, IPs, severities, status windows, or QDS filters.
        - Build affected-host evidence after a CVE or vulnerability title has been resolved to one or more QIDs.
      whenNotToUse:
        - Do not use for CSAM/GAV asset inventory or Cloud Agent coverage questions.
        - Do not use when a CVE or vulnerability title has not been resolved to QIDs; require source-backed evidence or an imported KB capability first.
        - Do not send params.status, params.detection_status, params.state, params.qid, or CSV output requests.
      parameters:
        status:
          summary: Optional top-level current detection status list.
          full: |
            Omitted status defaults to New,Active,Re-Opened for currently
            vulnerable exposure views. Use Fixed only for historical or closure
            analysis. Keep detection status at top level; do not put status,
            detection_status, or state under params.
        params:
          summary: Native Qualys Host Detection query parameters.
          full: |
            Optional key/value parameters forwarded to Host Detection after the
            tool enforces action=list. Common source-backed params include ids,
            ips, qids, severities, qds_min, qds_max, show_qds,
            show_qds_factors, include_vuln_type, show_arf_data,
            arf_filter_keys, filter_superseded_qids, show_reopened_info,
            detection_updated_since, detection_updated_before,
            max_days_since_detection_updated, detection_last_tested_since,
            detection_last_tested_since_days, detection_last_tested_before,
            detection_last_tested_before_days, arf_kernel_filter,
            arf_service_filter, arf_config_filter, vm_scan_since,
            no_vm_scan_since, detection_processed_before,
            detection_processed_after, show_asset_id, use_tags, tag_set_by,
            tag_include_selector, tag_exclude_selector, tag_set_include, and
            tag_set_exclude. Multiple filters are Qualys-native AND semantics.
        params.qids:
          summary: Comma-separated QID list for Host Detection filtering.
          full: Use plural qids. Singular params.qid is rejected because it is not the verified hosted Host Detection parameter.
        params.qds_min:
          summary: Optional minimum QDS host detection score.
          full: QDS is detection-level risk, not asset TruRisk and not CVE-level QVS. Use show_qds=1 with qds_min/qds_max.
        params.qds_max:
          summary: Optional maximum QDS host detection score.
        params.show_qds:
          summary: Set to 1 to request QDS fields.
        params.show_qds_factors:
          summary: Set to 1 when the user asks why QDS is high or asks for contributing factors.
        params.include_vuln_type:
          summary: confirmed or potential.
        params.detection_updated_since:
          summary: Optional status-change lower bound timestamp.
        params.detection_updated_before:
          summary: Optional status-change upper bound timestamp.
        params.detection_last_tested_since:
          summary: Optional retest recency lower bound timestamp.
        params.arf_service_filter:
          summary: Native ARF service filter; combine with show_arf_data=1 for running-service exploitability questions.
        params.show_asset_id:
          summary: Set to 1 when asset-to-QID evidence needs the Qualys asset id in returned host records.
        truncation_limit:
          summary: Optional Qualys page-size limit for Host Detection host records.
          full: Positive integer. Keep low for smoke tests; a single returned host can still contain multiple detection records.
        max_pages:
          summary: Optional maximum number of Host Detection pages to fetch.
          full: Positive integer cap for FO warning URL pagination. Use this to bound runtime and response size.
      examples:
        - status: New,Active,Re-Opened
          truncation_limit: 1
          max_pages: 1
          params:
            show_asset_id: 1
        - status: New,Active,Re-Opened
          truncation_limit: 1000
          max_pages: 5
          params:
            qids: "12345,67890"
            show_asset_id: 1
        - truncation_limit: 1000
          max_pages: 5
          params:
            qds_min: 70
            show_qds: 1
            show_qds_factors: 1
            include_vuln_type: confirmed
`;
}

function qualysVmdrKbVulnListHelpYaml(): string {
  return `
    help:
      summary: Resolve VMDR KnowledgeBase vulnerability metadata through POST /api/2.0/fo/knowledge_base/vuln/ by QID, CVE, date, or native KB parameters; metadata only, not tenant exposure proof.
      full: |
        Calls the Qualys KnowledgeBase Vulnerability List endpoint
        POST /api/2.0/fo/knowledge_base/vuln/ with action=list. Use this to
        resolve source-backed QID/CVE metadata, titles returned by Qualys,
        patchability, vendor references, CVE lists, and optional Threat
        Intelligence fields when requested with details=All. This is metadata
        only: it does not prove that any tenant host is affected. For tenant
        exposure, resolve a QID set here and then call
        qualys_vmdr_host_detection_list.
      whenToUse:
        - Resolve CVE or known QID input to KnowledgeBase vulnerability metadata.
        - Fetch bounded KB details before using QIDs in Host Detection tenant exposure checks.
        - Inspect KB metadata such as title, severity, CVEs, patchability, vendor references, or THREAT_INTELLIGENCE for known or bounded QIDs.
      whenNotToUse:
        - Do not use as tenant exposure proof; use Host Detection for affected-host evidence.
        - This tool is metadata only; never treat KB rows as affected-host proof.
        - Do not pass title-like strings, RTI names, or search-token paths as native KB params unless verified provider evidence exposes that exact parameter.
        - Do not add page_size, truncation_limit, Host Detection status, or Host Detection qids semantics to this KB call.
      parameters:
        params:
          summary: Required native Qualys KnowledgeBase action=list parameters.
          full: |
            Required key/value parameters forwarded to the KB endpoint after the
            tool enforces action=list. Common source-backed params include ids,
            details, id_min, id_max, cve, is_patchable, published_after,
            published_before, last_modified_after, last_modified_before,
            last_modified_by_user_after, last_modified_by_user_before,
            last_modified_by_service_after,
            last_modified_by_service_before, discovery_method,
            show_pci_reasons, show_supported_modules_info,
            show_disabled_flag, and show_qid_change_log. Use params.cve for a
            CVE lookup, not params.cve_ids. Use params.ids for known QIDs.
          rules:
            - Do not pass title-like strings, RTI names, or search-token paths as native KB params unless verified provider evidence exposes that exact parameter.
            - Use params.cve for CVE lookup and params.ids for known QIDs.
            - Do not use Host Detection params such as qids, status, or truncation_limit in this KB metadata call.
        params.ids:
          summary: Comma-separated Qualys QID list.
          full: Use when QIDs are already known or were resolved by a source-backed discovery step.
        params.cve:
          summary: CVE identifier for KB metadata lookup.
          full: Use params.cve, not params.cve_ids, for CVE-to-QID metadata resolution.
        params.details:
          summary: Detail level requested from KnowledgeBase.
          full: Use details=All when the caller needs CVE details, patchability, references, or THREAT_INTELLIGENCE fields.
        params.published_after:
          summary: Optional KB publication lower-bound timestamp.
        params.last_modified_after:
          summary: Optional KB last-modified lower-bound timestamp.
        params.is_patchable:
          summary: Optional native patchability filter when supported by the Qualys KB endpoint.
        max_pages:
          summary: Optional maximum number of KB pages to fetch.
          full: Positive integer cap for FO warning URL pagination. Use 1 for bounded live probes and increase only when the task needs broader metadata.
      examples:
        - params:
            ids: "90043,92080"
            details: All
          max_pages: 1
        - params:
            cve: CVE-2021-44228
            details: All
          max_pages: 1
`;
}

function qualysVmdrAssetGroupListHelpYaml(): string {
  return `
    help:
      summary: List VMDR asset groups through GET /api/2.0/fo/asset/group/?action=list using native Qualys params and FO warning URL pagination; returns ASSET_GROUP records.
      full: |
        Calls the Qualys VMDR Asset Group List endpoint
        GET /api/2.0/fo/asset/group/ with action=list. Use this for read-only
        asset group inventory and id/title metadata. The response is parsed from
        ASSET_GROUP records. Pass native params only when source-backed, such as
        ids for a known asset group id. Do not invent free-text search, tag, or
        GAV asset filter params for this FO endpoint.
      whenToUse:
        - List VMDR asset groups for administration or scan/report scope review.
        - Fetch a known VMDR asset group by native params.ids.
      whenNotToUse:
        - Do not use for CSAM/GAV asset inventory; use GAV asset tools.
        - Do not invent text search, tag filters, or GAV filter_body semantics for asset groups.
        - Do not use for creating, updating, or deleting asset groups.
      parameters:
        params:
          summary: Optional native Qualys Asset Group List action=list query parameters.
          full: |
            Optional key/value params forwarded to the Asset Group List endpoint
            after the tool enforces action=list. Source-backed example: params.ids for
            a known asset group id. Omit params for a bounded broad list. Do not
            invent title text-search or GAV filter_body fields unless provider
            evidence is added first.
          rules:
            - Do not invent unsupported text-search, tag, or GAV filter_body params.
            - Use params.ids only when the asset group id is known.
        params.ids:
          summary: Optional known Qualys asset group id or comma-separated ids.
        max_pages:
          summary: Optional maximum number of Asset Group List pages to fetch.
          full: Positive integer cap for FO warning URL pagination. Use 1 for bounded live probes.
      examples:
        - params: {}
          max_pages: 1
        - params:
            ids: "123"
          max_pages: 1
`;
}

function qualysVmdrIpListHelpYaml(): string {
  return `
    help:
      summary: List VMDR IP/range inventory through GET /api/2.0/fo/asset/ip/?action=list using native Qualys params and FO warning URL pagination; returns IP/RANGE records.
      full: |
        Calls the Qualys VMDR IP List endpoint GET /api/2.0/fo/asset/ip/ with
        action=list. Use this for the VMDR account IP/range inventory view, not
        for CSAM/GAV asset records. The response is parsed as IP/RANGE records.
        Pass native params only when source-backed, such as ips for a known IP
        or range. Do not invent GAV filter_body, Asset Group params, or
        free-text host search for this FO endpoint.
      whenToUse:
        - List VMDR IP/range records for account scope review.
        - Fetch bounded VMDR IP/range inventory using native params.ips.
      whenNotToUse:
        - Do not use for CSAM/GAV asset inventory or asset details; use GAV asset tools.
        - Do not use for VMDR Host List fields or host metadata; use qualys_vmdr_host_list.
        - Do not invent GAV filter_body, Asset Group ids, or free-text host search params.
        - Do not use for adding, removing, or changing IP scope.
      parameters:
        params:
          summary: Optional native Qualys IP List action=list query parameters.
          full: |
            Optional key/value params forwarded to the IP List endpoint after the
            tool enforces action=list. Source-backed example: params.ips for a
            known IP or range. Omit params for a bounded broad list. Do not
            invent GAV filter_body fields, Asset Group params, or host metadata
            filters unless provider evidence is added first.
          rules:
            - Do not invent unsupported GAV filter_body, Asset Group, or host metadata params.
            - Use params.ips only when the IP/range scope is known.
        params.ips:
          summary: Optional known IP address or Qualys-supported range/list selector.
        max_pages:
          summary: Optional maximum number of IP List pages to fetch.
          full: Positive integer cap for FO warning URL pagination. Use 1 for bounded live probes.
      examples:
        - params: {}
          max_pages: 1
        - params:
            ips: 10.0.0.1
          max_pages: 1
`;
}

function qualysVmdrExcludedIpListHelpYaml(): string {
  return `
    help:
      summary: List VMDR excluded IP/range records through GET /api/2.0/fo/asset/excluded_ip/?action=list using native Qualys params and FO warning URL pagination.
      full: |
        Calls the Qualys VMDR Excluded IP List endpoint
        GET /api/2.0/fo/asset/excluded_ip/ with action=list. Use this for the
        read-only excluded IP/range scope view, not for included IP inventory,
        VMDR host records, or CSAM/GAV asset records. The response is parsed as
        the provider XML response envelope for excluded IP/range records. Pass
        native params only when source-backed, such as ips for a known IP or
        range. Do not invent GAV filter_body, Asset Group params, included-IP
        endpoint params, or free-text host search for this FO endpoint.
      whenToUse:
        - List VMDR excluded IP/range records for account scope review.
        - Fetch bounded excluded IP/range inventory using native params.ips.
      whenNotToUse:
        - Do not use for included VMDR IP/range inventory; use qualys_vmdr_ip_list.
        - Do not use for CSAM/GAV asset inventory or VMDR Host List fields.
        - Do not invent GAV filter_body, Asset Group ids, included-IP params, or free-text host search params.
        - Do not use for adding, removing, or changing excluded IP scope.
      parameters:
        params:
          summary: Optional native Qualys Excluded IP List action=list query parameters.
          full: |
            Optional key/value params forwarded to the Excluded IP List endpoint
            after the tool enforces action=list. Source-backed example:
            params.ips for a known excluded IP or range. Omit params for a
            bounded broad list. Do not invent GAV filter_body fields, Asset
            Group params, included-IP endpoint params, or host metadata filters
            unless provider evidence is added first.
          rules:
            - Do not invent unsupported GAV filter_body, Asset Group, included-IP, or host metadata params.
            - Use params.ips only when the excluded IP/range scope is known.
        params.ips:
          summary: Optional known excluded IP address or Qualys-supported range/list selector.
        max_pages:
          summary: Optional maximum number of Excluded IP List pages to fetch.
          full: Positive integer cap for FO warning URL pagination. Use 1 for bounded live probes.
      examples:
        - params: {}
          max_pages: 1
        - params:
            ips: 10.0.0.1
          max_pages: 1
`;
}

function qualysVmdrRestrictedIpListHelpYaml(): string {
  return `
    help:
      summary: List VMDR restricted IP/range records through GET /api/2.0/fo/setup/restricted_ips/?action=list&output_format=xml using native Qualys params and FO warning URL pagination.
      full: |
        Calls the Qualys VMDR Restricted IP List endpoint
        GET /api/2.0/fo/setup/restricted_ips/ with action=list and
        output_format=xml. Use this for the read-only restricted IP/range scope
        view, not for included IP inventory, excluded IP inventory, VMDR host
        records, or CSAM/GAV asset records. The response is parsed as the
        provider XML response envelope for restricted IP/range records. Pass
        native params only when source-backed. Do not invent GAV filter_body,
        Asset Group params, included/excluded-IP endpoint params, or free-text
        host search for this FO endpoint.
      whenToUse:
        - List VMDR restricted IP/range records for account scope review.
        - Fetch bounded restricted IP/range inventory while preserving output_format=xml.
      whenNotToUse:
        - Do not use for included VMDR IP/range inventory; use qualys_vmdr_ip_list.
        - Do not use for excluded VMDR IP/range inventory; use qualys_vmdr_excluded_ip_list.
        - Do not use for CSAM/GAV asset inventory or VMDR Host List fields.
        - Do not invent GAV filter_body, Asset Group ids, included/excluded-IP params, or free-text host search params.
        - Do not use for adding, removing, or changing restricted IP scope.
      parameters:
        params:
          summary: Optional native Qualys Restricted IP List action=list query parameters.
          full: |
            Optional key/value params forwarded to the Restricted IP List endpoint
            after the tool enforces action=list and output_format=xml. Omit
            params for a bounded broad list. Do not override output_format and
            do not invent GAV filter_body fields, Asset Group params,
            included/excluded-IP endpoint params, or host metadata filters
            unless provider evidence is added first.
          rules:
            - output_format=xml is enforced by the tool.
            - Do not invent unsupported GAV filter_body, Asset Group, included/excluded-IP, or host metadata params.
        max_pages:
          summary: Optional maximum number of Restricted IP List pages to fetch.
          full: Positive integer cap for FO warning URL pagination. Use 1 for bounded live probes.
      examples:
        - params: {}
          max_pages: 1
`;
}

function qualysVmdrVirtualHostListHelpYaml(): string {
  return `
    help:
      summary: List VMDR VIRTUAL_HOST records through GET /api/2.0/fo/asset/vhost/?action=list using native Qualys params and FO warning URL pagination.
      full: |
        Calls the Qualys VMDR Virtual Host List endpoint
        GET /api/2.0/fo/asset/vhost/ with action=list. Use this for read-only
        VMDR virtual host inventory, not for normal VMDR hosts, IP scope, or
        CSAM/GAV asset records. The response is parsed from VIRTUAL_HOST
        records. Pass native params only when source-backed. Do not invent GAV
        filter_body, VMDR Host List params, IP scope params, or free-text host
        search for this FO endpoint.
      whenToUse:
        - List VMDR virtual host records for account inventory review.
        - Fetch bounded virtual host inventory using source-backed native params.
      whenNotToUse:
        - Do not use for normal VMDR Host List records; use qualys_vmdr_host_list.
        - Do not use for included/excluded/restricted IP scope inventory.
        - Do not use for CSAM/GAV asset inventory or asset details.
        - Do not invent GAV filter_body, Host List, IP scope, or free-text search params.
      parameters:
        params:
          summary: Optional native Qualys Virtual Host List action=list query parameters.
          full: |
            Optional key/value params forwarded to the Virtual Host List endpoint
            after the tool enforces action=list. Omit params for a bounded broad
            list. Do not invent GAV filter_body fields, VMDR Host List params,
            IP scope params, or host metadata filters unless provider evidence
            is added first.
          rules:
            - Do not invent unsupported GAV filter_body, Host List, IP scope, or host metadata params.
        max_pages:
          summary: Optional maximum number of Virtual Host List pages to fetch.
          full: Positive integer cap for FO warning URL pagination. Use 1 for bounded live probes.
      examples:
        - params: {}
          max_pages: 1
`;
}

function qualysVmdrScanListHelpYaml(): string {
  return `
    help:
      summary: List VMDR scan metadata and SCAN records through GET /api/2.0/fo/scan/?action=list using native Qualys params and FO warning URL pagination; does not fetch scan result payloads.
      full: |
        Calls the Qualys VMDR Scan List endpoint GET /api/2.0/fo/scan/ with
        action=list. Use this for read-only scan metadata discovery and to
        find scan_ref values before a fetch. The response is parsed from
        SCAN records. This tool does not fetch scan result payloads, launch scans,
        cancel scans, or mutate scan state.
      whenToUse:
        - List VMDR scan metadata and discover scan_ref values.
        - Fetch bounded scan history using source-backed native params such as launched_after_datetime, launched_before_datetime, state, or target.
      whenNotToUse:
        - Do not use to fetch a known scan_ref payload; use qualys_vmdr_scan_fetch.
        - Do not use to launch, cancel, pause, resume, delete, or otherwise mutate scan state.
        - Do not invent GAV filter_body, Host List, IP scope, or vulnerability params for scan listing.
      parameters:
        params:
          summary: Optional native Qualys VMDR Scan List action=list query parameters.
          full: |
            Optional key/value params forwarded to the Scan List endpoint after
            the tool enforces action=list. Common source-backed params include
            launched_after_datetime, launched_before_datetime, state, target,
            and user_login. Do not pass scan_ref here; use
            qualys_vmdr_scan_fetch for a known scan_ref.
          rules:
            - Do not pass scan_ref to list; scan_ref belongs to qualys_vmdr_scan_fetch.
            - Do not invent unsupported GAV filter_body, Host List, IP scope, or vulnerability params.
        params.launched_after_datetime:
          summary: Optional native lower-bound launch timestamp.
        params.state:
          summary: Optional native scan state filter when source-backed.
        max_pages:
          summary: Optional maximum number of Scan List pages to fetch.
          full: Positive integer cap for FO warning URL pagination. Use 1 for bounded live probes.
      examples:
        - params: {}
          max_pages: 1
        - params:
            launched_after_datetime: "2026-08-01T00:00:00Z"
          max_pages: 1
`;
}

function qualysVmdrScanFetchHelpYaml(): string {
  return `
    help:
      summary: Fetch an existing VMDR scan result payload through GET /api/2.0/fo/scan/?action=fetch for a real discovered scan_ref; output can become a hosted artifact.
      full: |
        Calls the Qualys VMDR Scan Fetch endpoint GET /api/2.0/fo/scan/
        with action=fetch and a required top-level scan_ref. Use this only
        after qualys_vmdr_scan_list has returned a real scan_ref and the caller
        needs the scan result payload itself. Fetch output can be large, so the
        hosted response choke point may return an artifact reference instead of
        inline content. This tool does not list scans, summarize scans, launch
        scans, cancel scans, or mutate scan state.
      whenToUse:
        - Fetch the scan result payload for a known, real scan_ref discovered from qualys_vmdr_scan_list.
        - Retrieve bounded scan output with native params such as mode, output_format, or ips.
      whenNotToUse:
        - Do not use when scan_ref is unknown; discover it with qualys_vmdr_scan_list first.
        - Do not use for scan metadata lists or summaries; use qualys_vmdr_scan_list, qualys_vmdr_scan_summary, or qualys_vmdr_scan_vm_summary.
        - Do not use to launch, cancel, pause, resume, delete, or otherwise mutate scan state.
      parameters:
        scan_ref:
          summary: Required real Qualys scan_ref discovered from scan list output.
          full: |
            Required top-level scan_ref sent with action=fetch.
            Discover this value with qualys_vmdr_scan_list, usually by listing
            a bounded set of Finished scans. Do not pass placeholder refs such as
            scan/123456.789, <real-scan-ref>, empty strings, or guessed refs.
          rules:
            - Discover scan_ref with qualys_vmdr_scan_list before calling fetch.
            - Do not pass placeholder or guessed scan refs.
        params:
          summary: Optional native Qualys Scan Fetch parameters.
          full: |
            Optional key/value params forwarded to the Scan Fetch endpoint after
            the tool enforces action=fetch and the top-level scan_ref. Source-
            backed optional params include ips, mode, and output_format.
            scan_ref belongs at the top level; do not put scan_ref or action
            inside params. Use narrow output options because scan fetch
            payloads can be large.
          rules:
            - action=fetch is enforced by the hosted tool.
            - scan_ref belongs at the top level, not inside params.
            - Use narrow output options when possible because fetch payloads can be large.
        params.mode:
          summary: Optional native fetch mode such as brief when source-backed.
        params.output_format:
          summary: Optional native output format such as json or xml when source-backed.
        params.ips:
          summary: Optional native IP scope for narrowing the fetched scan payload.
      examples:
        - discovery:
            first_call: qualys_vmdr_scan_list
            requirement: Use a real scan_ref returned by scan list output before calling fetch.
          fetch_args_after_discovery:
            params:
              mode: brief
              output_format: json
          not_ready_to_send: true
`;
}

function qualysVmdrKbQvsListHelpYaml(): string {
  return `
    help:
      summary: Fetch VMDR KnowledgeBase QVS JSON metadata through /api/3.0/fo/knowledge_base/qvs/?action=list for bounded CVE/vulnerability-level QVS enrichment; does not prove tenant exposure.
      full: |
        Calls the Qualys KnowledgeBase QVS list endpoint
        /api/3.0/fo/knowledge_base/qvs/?action=list. Use this for
        CVE/vulnerability-level QVS, EPSS, and exploit-maturity enrichment when
        the user asks for vulnerability score context. QVS is not QDS: QDS is
        host-detection level evidence from Host Detection params such as
        show_qds, qds_min, and qds_max. QVS does not prove tenant exposure; use
        qualys_vmdr_host_detection_list for affected-host evidence.
      whenToUse:
        - Fetch CVE/vulnerability-level QVS metadata for a known CVE or bounded QVS/date filter.
        - Enrich KB/QID analysis with CVE-level score context before a Host Detection exposure lookup.
      whenNotToUse:
        - Do not use as tenant exposure proof; QVS does not prove tenant exposure.
        - Do not use for Host Detection QDS filtering or detection-level risk; use qualys_vmdr_host_detection_list with show_qds/qds_min/qds_max.
        - Do not add page_size, truncation_limit, Host Detection status, or Host Detection qids semantics to this QVS call.
      parameters:
        params:
          summary: Required native Qualys QVS action=list parameters with a bounded filter.
          full: |
            Required key/value parameters forwarded to the QVS endpoint after the
            tool enforces action=list. Use at least one bounded filter such as
            cve, qvs_min, qvs_max, qvs_last_modified_after,
            qvs_last_modified_before, nvd_published_after, or
            nvd_published_before. Common source-backed params include details
            with values Basic or All. Do not use Host Detection QDS parameters
            such as qds_min, qds_max, show_qds, or show_qds_factors here.
          rules:
            - QVS is CVE/vulnerability-level score context, not Host Detection QDS.
            - Use params.cve for CVE-specific QVS lookup.
            - Do not send unbounded empty params.
        params.cve:
          summary: CVE identifier for QVS lookup.
        params.details:
          summary: Optional QVS detail level.
          full: Use Basic for compact score checks and All when the caller needs contributing factors or richer QVS context.
        params.qvs_min:
          summary: Optional minimum CVE/vulnerability-level QVS score.
          full: QVS is CVE/vulnerability-level. Do not confuse this with Host Detection qds_min.
        params.qvs_max:
          summary: Optional maximum CVE/vulnerability-level QVS score.
        params.qvs_last_modified_after:
          summary: Optional QVS last-modified lower-bound timestamp.
        params.nvd_published_after:
          summary: Optional NVD publication lower-bound timestamp.
      examples:
        - params:
            cve: CVE-2021-44228
            details: All
        - params:
            qvs_min: 80
            details: Basic
`;
}

function qualysAssetManagementTagListHelpYaml(): string {
  return `
    help:
      summary: List Qualys Asset Management tag records through POST /qps/rest/2.0/search/am/tag using QPS ServiceRequest XML and optional limitResults; intentionally accepts only limit.
      full: |
        Calls the Qualys QPS Asset Management tag search endpoint
        POST /qps/rest/2.0/search/am/tag with a ServiceRequest XML body and no
        Criteria filters. Use this only for bounded all-tag pulls, for example
        limit=1 for smoke tests or a small caller-requested limit for review.
        The response is parsed from ServiceResponse.data.Tag records. This tool
        intentionally accepts only limit; use qualys_asset_management_tag_search
        for filtered tag lookups.
      whenToUse:
        - Pull a bounded page of Asset Management tag records without filters.
        - Smoke-test QPS Asset Management tag connectivity with limit=1.
      whenNotToUse:
        - Do not use "*" or placeholder filter values; this tool has no filter input.
        - Do not pass criteria, field, operator, value, page_size, or max_pages.
        - Use qualys_asset_management_tag_search for filtered tag lookup by name or id.
        - Do not use for creating, updating, or deleting tags.
      parameters:
        limit:
          summary: Optional positive ServiceRequest preferences.limitResults cap.
          full: |
            Positive integer mapped to preferences.limitResults in the QPS
            ServiceRequest. Use 1 for smoke tests. This is the only accepted
            input; the tool does not accept criteria, page_size, max_pages, or
            wildcard filters.
          rules:
            - Omit or set a positive integer.
            - Use small bounded limits for live probes.
      examples:
        - limit: 1
`;
}

function qualysAssetManagementTagSearchHelpYaml(): string {
  return `
    help:
      summary: Search Qualys Asset Management tag records through POST /qps/rest/2.0/search/am/tag using QPS ServiceRequest XML Criteria and returning ServiceResponse.data.Tag records.
      full: |
        Calls the Qualys QPS Asset Management tag search endpoint
        POST /qps/rest/2.0/search/am/tag with a ServiceRequest XML body. Use
        this for read-only tag record discovery by known bounded tag Criteria,
        such as name CONTAINS Cloud. The response is parsed from
        ServiceResponse.data.Tag records. This is not a GAV asset search and
        does not return assets assigned to a tag.
      whenToUse:
        - Search Asset Management tag records by bounded QPS Criteria.
        - Resolve tag ids or tag metadata before using tag-related asset filters.
      whenNotToUse:
        - Do not use "*" or empty values to enumerate every tag.
        - Do not use for GAV asset inventory or finding assets assigned to a tag; use GAV asset tools with source-backed tag filters.
        - Do not use for creating, updating, or deleting tags.
      parameters:
        criteria:
          summary: Required QPS Criteria array for the ServiceRequest filters block.
          full: |
            Required non-empty array. Each item becomes a QPS Criteria element
            with field, operator, and value. Source-backed fields for this
            hosted surface are id, name, created, modified, and color. The
            common safe lookup is {"field":"name","operator":"CONTAINS",
            "value":"Cloud"}. Do not pass a bare string, do not pass "*", and
            do not pass GAV asset filter fields such as asset.name here.
          rules:
            - Every criteria item must contain non-empty field, operator, and value.
            - Do not use "*" or empty values for broad tag enumeration.
            - QPS Criteria fields are not GAV asset filter fields.
        criteria.field:
          summary: QPS tag Criteria field.
          full: Source-backed fields for this hosted contract are id, name, created, modified, and color.
        criteria.operator:
          summary: QPS tag Criteria operator.
          full: Use source-backed QPS operators such as EQUALS or CONTAINS when supported for the chosen field.
        criteria.value:
          summary: QPS tag Criteria value.
          full: Non-empty bounded search value. Do not use "*" for all tags.
        limit:
          summary: Optional positive ServiceRequest preferences.limitResults cap.
          full: |
            Positive integer mapped to preferences.limitResults in the QPS
            ServiceRequest. Use a small value for live probes. This is not
            page_size and there is no continuation token in this hosted tool.
      examples:
        - criteria:
            - field: name
              operator: CONTAINS
              value: Cloud
          limit: 1
        - criteria:
            - field: id
              operator: EQUALS
              value: "12345"
          limit: 1
`;
}

export function qualysGavFilterFieldsVocabularyJson(): string {
  return JSON.stringify(
    {
      kind: "openacme.hostedParameterVocabulary",
      version: 1,
      id: "qualys-gav-filter-fields",
      familyId: "qualys",
      parameterPath: "filter_body.filters.field",
      entries: [
        {
          value: "asset.name",
          summary: "CSAM/GAV asset name filter field.",
          operators: ["EQUALS", "CONTAINS"],
          aliases: ["hostname", "host name"],
        },
        {
          value: "operatingSystem.category1",
          summary: "Top-level operating system category filter field.",
          operators: ["EQUALS"],
          aliases: ["os category"],
        },
        {
          value: "operatingSystem.category2",
          summary: "Second-level operating system category filter field.",
          operators: ["EQUALS"],
          aliases: ["server workstation category"],
        },
        {
          value: "software.name",
          summary: "Installed software name filter field.",
          operators: ["EQUALS", "CONTAINS"],
          aliases: ["installed software"],
        },
        {
          value: "qualys.agent.lastCheckedInDate",
          summary: "Cloud Agent last check-in timestamp filter field.",
          operators: ["GREATER", "LESSER", "EQUALS"],
          aliases: ["last check in", "agent checkin"],
        },
        {
          value: "asset.trackingMethod",
          summary:
            "Asset tracking method field; Cloud Agent tools enforce QAGENT automatically.",
          operators: ["EQUALS"],
          aliases: ["tracking method"],
        },
      ],
      invalidAliases: [
        {
          value: "assetName",
          reason:
            "assetName is a response projection field, not a GAV filter field.",
          use: "asset.name",
        },
        {
          value: "asset_last_updated",
          reason:
            "asset_last_updated is a hosted tool request parameter, not a GAV filter field.",
          use: "top-level asset_last_updated argument",
        },
        {
          value: "assetLastUpdated",
          reason:
            "assetLastUpdated is sent as a top-level query parameter by the hosted tool.",
          use: "top-level asset_last_updated argument",
        },
        {
          value: "last_seen_asset_id",
          reason:
            "last_seen_asset_id is a hosted pagination cursor argument, not a GAV filter field.",
          use: "top-level last_seen_asset_id argument",
        },
        {
          value: "agent.lastCheckedIn",
          reason:
            "agent.lastCheckedIn is a legacy/cache alias, not the hosted live GAV field token.",
          use: "qualys.agent.lastCheckedInDate",
        },
      ],
    },
    null,
    2,
  );
}

export function qualysCurrentPromotedReadOnlySourceBackedPythonSource(): string {
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
HOST_DETECTION_ENDPOINT = "/api/2.0/fo/asset/host/vm/detection/"
KB_VULN_ENDPOINT = "/api/2.0/fo/knowledge_base/vuln/"
KB_QVS_ENDPOINT = "/api/3.0/fo/knowledge_base/qvs/"
ASSET_TAG_SEARCH_ENDPOINT = "/qps/rest/2.0/search/am/tag"
QAGENT_FILTER = {"field": "asset.trackingMethod", "operator": "EQUALS", "value": "QAGENT"}
_GAV_FILTER_VOCABULARY = None


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


def tool_qualys_vmdr_host_detection_list(args, context):
    _validate_host_detection_args(args)
    client = _authenticated_client(context)
    return client.list_host_detections(
        status=_optional_string(args, "status"),
        truncation_limit=_positive_int(args, "truncation_limit"),
        params=_native_params_arg(args),
        max_pages=_positive_int(args, "max_pages"),
    )


def tool_qualys_vmdr_asset_group_list(args, context):
    _validate_asset_group_list_args(args)
    client = _authenticated_client(context)
    return client.list_asset_groups(
        params=_native_params_arg(args),
        max_pages=_positive_int(args, "max_pages"),
    )


def tool_qualys_vmdr_ip_list(args, context):
    _validate_ip_list_args(args)
    client = _authenticated_client(context)
    return client.list_ips(
        params=_native_params_arg(args),
        max_pages=_positive_int(args, "max_pages"),
    )


def tool_qualys_vmdr_excluded_ip_list(args, context):
    _validate_excluded_ip_list_args(args)
    client = _authenticated_client(context)
    return client.list_excluded_ips(
        params=_native_params_arg(args),
        max_pages=_positive_int(args, "max_pages"),
    )


def tool_qualys_vmdr_restricted_ip_list(args, context):
    _validate_restricted_ip_list_args(args)
    client = _authenticated_client(context)
    return client.list_restricted_ips(
        params=_native_params_arg(args),
        max_pages=_positive_int(args, "max_pages"),
    )


def tool_qualys_vmdr_virtual_host_list(args, context):
    _validate_virtual_host_list_args(args)
    client = _authenticated_client(context)
    return client.list_virtual_hosts(
        params=_native_params_arg(args),
        max_pages=_positive_int(args, "max_pages"),
    )


def tool_qualys_vmdr_scan_list(args, context):
    _validate_scan_list_args(args)
    client = _authenticated_client(context)
    return client.list_vm_scans(
        params=_native_params_arg(args),
        max_pages=_positive_int(args, "max_pages"),
    )


def tool_qualys_vmdr_scan_fetch(args, context):
    _validate_scan_fetch_args(args)
    client = _authenticated_client(context)
    return client.fetch_vm_scan(
        scan_ref=_required_string(args, "scan_ref"),
        params=_native_params_arg(args),
    )


def tool_qualys_vmdr_kb_vuln_list(args, context):
    _validate_kb_vuln_args(args)
    client = _authenticated_client(context)
    return client.list_kb_vulns(
        params=_native_params_arg(args, required=True),
        max_pages=_positive_int(args, "max_pages"),
    )


def tool_qualys_vmdr_kb_qvs_list(args, context):
    _validate_kb_qvs_args(args)
    client = _authenticated_client(context)
    return client.list_kb_qvs(params=_native_params_arg(args, required=True))


def tool_qualys_asset_management_tag_list(args, context):
    _validate_tag_list_args(args)
    client = _authenticated_client(context)
    return client.list_asset_tags(limit=_positive_int(args, "limit"))


def tool_qualys_asset_management_tag_search(args, context):
    criteria = _qps_criteria_list_arg(args, required=True)
    client = _authenticated_client(context)
    return client.search_asset_tags(
        criteria=criteria,
        limit=_positive_int(args, "limit"),
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


def tool_qualys_gav_asset_get(args, context):
    asset_id = _positive_int_required(args, "asset_id")
    include_fields = _optional_string_list(args.get("include_fields"), "include_fields")
    exclude_fields = _optional_string_list(args.get("exclude_fields"), "exclude_fields")
    if include_fields is not None and exclude_fields is not None:
        raise QualysToolError("bad_arguments", "Use include_fields or exclude_fields, not both")
    client = _authenticated_client(context)
    return client.get_asset(
        asset_id=asset_id,
        include_fields=include_fields,
        exclude_fields=exclude_fields,
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

    def list_host_detections(self, status=None, truncation_limit=None, params=None, max_pages=None):
        request_params = _native_params({"action": "list"}, params)
        request_params["action"] = "list"
        request_params["status"] = status or "New,Active,Re-Opened"
        if truncation_limit is not None or "truncation_limit" not in request_params:
            request_params["truncation_limit"] = str(truncation_limit or self.default_truncation_limit)
        return self._paginate_hosts(f"{self.vm_url}{HOST_DETECTION_ENDPOINT}", request_params, max_pages=max_pages)

    def list_asset_groups(self, params=None, max_pages=None):
        request_params = _native_params({"action": "list"}, params)
        request_params["action"] = "list"
        return self._paginate_xml_records(
            f"{self.vm_url}/api/2.0/fo/asset/group/",
            request_params,
            ".//ASSET_GROUP",
            max_pages=max_pages,
            method="GET",
        )

    def list_ips(self, params=None, max_pages=None):
        request_params = _native_params({"action": "list"}, params)
        request_params["action"] = "list"
        return self._read_xml_endpoint(
            f"{self.vm_url}/api/2.0/fo/asset/ip/",
            request_params,
            max_pages=max_pages,
            method="GET",
        )

    def list_excluded_ips(self, params=None, max_pages=None):
        request_params = _native_params({"action": "list"}, params)
        request_params["action"] = "list"
        return self._read_xml_endpoint(
            f"{self.vm_url}/api/2.0/fo/asset/excluded_ip/",
            request_params,
            max_pages=max_pages,
            method="GET",
        )

    def list_restricted_ips(self, params=None, max_pages=None):
        request_params = _native_params({"action": "list", "output_format": "xml"}, params)
        request_params["action"] = "list"
        request_params["output_format"] = "xml"
        return self._read_xml_endpoint(
            f"{self.vm_url}/api/2.0/fo/setup/restricted_ips/",
            request_params,
            max_pages=max_pages,
            method="GET",
        )

    def list_virtual_hosts(self, params=None, max_pages=None):
        request_params = _native_params({"action": "list"}, params)
        request_params["action"] = "list"
        return self._paginate_xml_records(
            f"{self.vm_url}/api/2.0/fo/asset/vhost/",
            request_params,
            ".//VIRTUAL_HOST",
            max_pages=max_pages,
            method="GET",
        )

    def list_vm_scans(self, params=None, max_pages=None):
        request_params = _native_params({"action": "list"}, params)
        request_params["action"] = "list"
        return self._paginate_xml_records(
            f"{self.vm_url}/api/2.0/fo/scan/",
            request_params,
            ".//SCAN",
            max_pages=max_pages,
            method="GET",
        )

    def fetch_vm_scan(self, scan_ref, params=None):
        request_params = _native_params({"action": "fetch", "scan_ref": scan_ref}, params)
        request_params["action"] = "fetch"
        request_params["scan_ref"] = scan_ref
        response_text = self._get_text(f"{self.vm_url}/api/2.0/fo/scan/", params=request_params)
        return {
            "scan_ref": scan_ref,
            "params": params or {},
            "response_text": response_text,
            "bytes": len(response_text.encode("utf-8")),
            "artifact_recommended": True,
        }

    def list_kb_vulns(self, params, max_pages=None):
        request_params = _native_params({"action": "list"}, params)
        request_params["action"] = "list"
        return self._paginate_xml_records(
            f"{self.vm_url}{KB_VULN_ENDPOINT}",
            request_params,
            ".//VULN",
            max_pages=max_pages,
            method="POST",
        )

    def list_kb_qvs(self, params):
        request_params = _native_params({"action": "list"}, params)
        request_params["action"] = "list"
        response = self._get_json(f"{self.vm_url}{KB_QVS_ENDPOINT}", params=request_params)
        return {
            "response": response,
            "qvs_metadata": True,
            "used_params": params,
        }

    def list_asset_tags(self, limit=None):
        body = _qps_service_request_xml(criteria=[], limit=limit)
        root = self._post_qps_xml(f"{self.vm_url}{ASSET_TAG_SEARCH_ENDPOINT}", body)
        parsed = _parse_qps_service_response(root, ".//Tag")
        return {
            **parsed,
            "qps_tag_list": True,
            "limit": limit,
        }

    def search_asset_tags(self, criteria, limit=None):
        body = _qps_service_request_xml(criteria=criteria, limit=limit)
        root = self._post_qps_xml(f"{self.vm_url}{ASSET_TAG_SEARCH_ENDPOINT}", body)
        parsed = _parse_qps_service_response(root, ".//Tag")
        return {
            **parsed,
            "qps_tag_search": True,
            "limit": limit,
            "criteria": criteria,
        }

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

    def get_asset(self, asset_id, include_fields=None, exclude_fields=None):
        upstream_include_fields = _upstream_asset_field_names(include_fields)
        upstream_exclude_fields = _upstream_asset_field_names(exclude_fields)
        params = {"assetId": str(asset_id)}
        if upstream_include_fields:
            params["includeFields"] = ",".join(upstream_include_fields)
        if upstream_exclude_fields:
            params["excludeFields"] = ",".join(upstream_exclude_fields)
        response = self._get_gateway_json(
            f"{self.gateway_url}/rest/2.0/get/am/asset",
            params=params,
        )
        assets = [
            _project_asset_fields(
                asset,
                include_fields=include_fields,
                exclude_fields=exclude_fields,
            )
            for asset in _asset_records(response)
        ]
        return {
            "results": assets,
            "direct_asset_get": True,
            "asset_id": asset_id,
            "include_fields": include_fields,
            "exclude_fields": exclude_fields,
            "upstream_include_fields": upstream_include_fields,
            "upstream_exclude_fields": upstream_exclude_fields,
        }

    def _paginate_hosts(self, url, params, max_pages=None):
        return self._paginate_xml_records(url, params, ".//HOST", max_pages=max_pages, method="GET")

    def _read_xml_endpoint(self, url, params, max_pages=None, method="GET"):
        max_pages = max_pages or self.max_pages
        if not isinstance(max_pages, int) or max_pages < 1:
            raise QualysToolError("bad_arguments", "max_pages must be a positive integer")
        pages = 0
        next_url = None
        last_response = None
        truncated = False
        while True:
            if next_url:
                root = self._get_xml(next_url)
            elif method == "POST":
                root = self._post_xml_form(url, params)
            else:
                root = self._get_xml(url, params=params)
            last_response = _xml_to_obj(root)
            pages += 1
            warning_url = _first_text(root, ".//WARNING/URL")
            if not warning_url:
                break
            if pages >= max_pages:
                truncated = True
                break
            next_url = warning_url
        return {"response": last_response, "truncated": truncated, "pages_fetched": pages}

    def _paginate_xml_records(self, url, params, record_path, max_pages=None, method="GET"):
        max_pages = max_pages or self.max_pages
        if not isinstance(max_pages, int) or max_pages < 1:
            raise QualysToolError("bad_arguments", "max_pages must be a positive integer")
        records = []
        pages = 0
        next_url = None
        truncated = False
        while True:
            if next_url:
                root = self._get_xml(next_url)
            elif method == "POST":
                root = self._post_xml_form(url, params)
            else:
                root = self._get_xml(url, params=params)
            for record_elem in root.findall(record_path):
                records.append(_xml_to_obj(record_elem))
            pages += 1
            warning_url = _first_text(root, ".//WARNING/URL")
            if not warning_url:
                break
            if pages >= max_pages:
                truncated = True
                break
            next_url = warning_url
        return {"results": records, "truncated": truncated, "pages_fetched": pages}

    def _post_xml_form(self, url, data):
        req = Request(
            url,
            data=urlencode(data).encode(),
            headers={
                **_browser_gate_headers(),
                "Authorization": self._auth_header(),
                "X-Requested-With": "curl",
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/xml,text/xml,*/*",
            },
            method="POST",
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

    def _post_qps_xml(self, url, body_xml):
        req = Request(
            url,
            data=body_xml.encode(),
            headers={
                **_browser_gate_headers(),
                "Authorization": self._auth_header(),
                "X-Requested-With": "curl",
                "Content-Type": "application/xml",
                "Accept": "application/xml,text/xml,*/*",
            },
            method="POST",
        )
        body = self._request_bytes(req, "Qualys QPS", parse_xml_cooldown=True)
        try:
            root = ET.fromstring(body)
        except ET.ParseError as exc:
            raise QualysToolError("upstream_error", f"Could not parse Qualys QPS XML response: {exc}")
        response_code = _first_text(root, ".//responseCode")
        if response_code and response_code.upper() != "SUCCESS":
            message = _first_text(root, ".//errorMessage") or _first_text(root, ".//message") or response_code
            raise QualysToolError("upstream_error", f"Qualys QPS returned {response_code}: {message}")
        return root

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

    def _get_json(self, url, params=None):
        full_url = f"{url}?{urlencode(params)}" if params else url
        req = Request(
            full_url,
            headers={
                **_browser_gate_headers(),
                "Authorization": self._auth_header(),
                "X-Requested-With": "curl",
                "Accept": "application/json,*/*",
            },
            method="GET",
        )
        raw = self._request_bytes(req, "Qualys").decode("utf-8", errors="replace")
        stripped = raw.strip()
        if not stripped:
            raise QualysToolError("upstream_error", "Qualys returned an empty JSON response")
        try:
            return json.loads(stripped)
        except json.JSONDecodeError as exc:
            raise QualysToolError("upstream_error", f"Could not parse Qualys JSON response: {exc}; first 300 chars: {raw[:300]}")

    def _get_text(self, url, params=None):
        full_url = f"{url}?{urlencode(params)}" if params else url
        req = Request(
            full_url,
            headers={
                **_browser_gate_headers(),
                "Authorization": self._auth_header(),
                "X-Requested-With": "curl",
                "Accept": "application/json,application/xml,text/xml,text/plain,*/*",
            },
            method="GET",
        )
        raw = self._request_bytes(req, "Qualys", parse_xml_cooldown=True).decode("utf-8", errors="replace")
        if not raw.strip():
            raise QualysToolError("upstream_error", "Qualys returned an empty scan fetch response")
        return raw

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

    def _get_gateway_json(self, url, params=None):
        full_url = f"{url}?{urlencode(params)}" if params else url
        req = Request(
            full_url,
            headers={
                **_browser_gate_headers(),
                "Authorization": f"Bearer {self._get_jwt()}",
                "Accept": "application/json",
            },
            method="GET",
        )
        raw = self._request_bytes(req, "Qualys Gateway").decode("utf-8", errors="replace")
        stripped = raw.strip()
        if not stripped:
            raise QualysToolError("upstream_error", "Qualys Gateway returned an empty asset get response")
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
        token_lower = token.lower()
        if token.startswith("<") or token_lower.startswith("<!doctype") or token_lower.startswith("<html"):
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
    include_fields = _optional_string_list(args.get("include_fields"), "include_fields")
    exclude_fields = _optional_string_list(args.get("exclude_fields"), "exclude_fields")
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


def _validate_host_detection_args(args):
    params = args.get("params") or {}
    if any(str(key).lower() in {"status", "detection_status", "state"} for key in params):
        raise QualysToolError("bad_arguments", "Host Detection status belongs in top-level status, not params.status, params.detection_status, or params.state")
    if "qid" in params:
        raise QualysToolError("bad_arguments", "Use plural params.qids for VMDR Host Detection filters; singular params.qid is not supported")
    for field in ("truncation_limit", "max_pages"):
        _validate_positive(args, field)


def _validate_asset_group_list_args(args):
    params = args.get("params") or {}
    if not isinstance(params, dict):
        raise QualysToolError("bad_arguments", "params must be an object when provided")
    forbidden_top_level = {"page_size", "truncation_limit", "filter_body", "criteria"}
    for key in forbidden_top_level:
        if key in args:
            raise QualysToolError("bad_arguments", f"{key} is not supported by VMDR Asset Group List; use native params plus max_pages only")
    forbidden_params = {
        "title": "Asset Group title text search is not a verified native parameter for this hosted tool.",
        "name": "Asset Group name search is not a verified native parameter for this hosted tool.",
        "filter_body": "GAV filter_body does not apply to VMDR Asset Group List.",
    }
    for key in params:
        lower = str(key).lower()
        if lower in forbidden_params:
            raise QualysToolError("bad_arguments", forbidden_params[lower])
    _validate_positive(args, "max_pages")


def _validate_ip_list_args(args):
    params = args.get("params") or {}
    if not isinstance(params, dict):
        raise QualysToolError("bad_arguments", "params must be an object when provided")
    forbidden_top_level = {"page_size", "truncation_limit", "filter_body", "criteria"}
    for key in forbidden_top_level:
        if key in args:
            raise QualysToolError("bad_arguments", f"{key} is not supported by VMDR IP List; use native params plus max_pages only")
    forbidden_params = {
        "filter_body": "GAV filter_body does not apply to VMDR IP List.",
        "ag_ids": "Asset Group params belong to Host List or Asset Group List, not VMDR IP List.",
        "ag_titles": "Asset Group params belong to Host List or Asset Group List, not VMDR IP List.",
        "hostname": "VMDR IP List is not a free-text host search tool.",
        "host": "VMDR IP List is not a free-text host search tool.",
    }
    for key in params:
        lower = str(key).lower()
        if lower in forbidden_params:
            raise QualysToolError("bad_arguments", forbidden_params[lower])
    _validate_positive(args, "max_pages")


def _validate_excluded_ip_list_args(args):
    params = args.get("params") or {}
    if not isinstance(params, dict):
        raise QualysToolError("bad_arguments", "params must be an object when provided")
    forbidden_top_level = {"page_size", "truncation_limit", "filter_body", "criteria"}
    for key in forbidden_top_level:
        if key in args:
            raise QualysToolError("bad_arguments", f"{key} is not supported by VMDR Excluded IP List; use native params plus max_pages only")
    forbidden_params = {
        "filter_body": "GAV filter_body does not apply to VMDR Excluded IP List.",
        "ag_ids": "Asset Group params belong to Host List or Asset Group List, not VMDR Excluded IP List.",
        "ag_titles": "Asset Group params belong to Host List or Asset Group List, not VMDR Excluded IP List.",
        "hostname": "VMDR Excluded IP List is not a free-text host search tool.",
        "host": "VMDR Excluded IP List is not a free-text host search tool.",
    }
    for key in params:
        lower = str(key).lower()
        if lower in forbidden_params:
            raise QualysToolError("bad_arguments", forbidden_params[lower])
    _validate_positive(args, "max_pages")


def _validate_restricted_ip_list_args(args):
    params = args.get("params") or {}
    if not isinstance(params, dict):
        raise QualysToolError("bad_arguments", "params must be an object when provided")
    forbidden_top_level = {"page_size", "truncation_limit", "filter_body", "criteria", "output_format"}
    for key in forbidden_top_level:
        if key in args:
            raise QualysToolError("bad_arguments", f"{key} is not supported by VMDR Restricted IP List; use native params plus max_pages only")
    forbidden_params = {
        "filter_body": "GAV filter_body does not apply to VMDR Restricted IP List.",
        "ag_ids": "Asset Group params belong to Host List or Asset Group List, not VMDR Restricted IP List.",
        "ag_titles": "Asset Group params belong to Host List or Asset Group List, not VMDR Restricted IP List.",
        "hostname": "VMDR Restricted IP List is not a free-text host search tool.",
        "host": "VMDR Restricted IP List is not a free-text host search tool.",
        "output_format": "output_format=xml is enforced by the hosted tool; do not pass output_format.",
    }
    for key in params:
        lower = str(key).lower()
        if lower in forbidden_params:
            raise QualysToolError("bad_arguments", forbidden_params[lower])
    _validate_positive(args, "max_pages")


def _validate_virtual_host_list_args(args):
    params = args.get("params") or {}
    if not isinstance(params, dict):
        raise QualysToolError("bad_arguments", "params must be an object when provided")
    forbidden_top_level = {"page_size", "truncation_limit", "filter_body", "criteria"}
    for key in forbidden_top_level:
        if key in args:
            raise QualysToolError("bad_arguments", f"{key} is not supported by VMDR Virtual Host List; use native params plus max_pages only")
    forbidden_params = {
        "filter_body": "GAV filter_body does not apply to VMDR Virtual Host List.",
        "ips": "IP scope params belong to VMDR IP List, not Virtual Host List.",
        "ag_ids": "Asset Group/Host List params are not verified for VMDR Virtual Host List.",
        "ag_titles": "Asset Group/Host List params are not verified for VMDR Virtual Host List.",
        "hostname": "VMDR Virtual Host List is not a free-text host search tool.",
        "host": "VMDR Virtual Host List is not a free-text host search tool.",
    }
    for key in params:
        lower = str(key).lower()
        if lower in forbidden_params:
            raise QualysToolError("bad_arguments", forbidden_params[lower])
    _validate_positive(args, "max_pages")


def _validate_scan_list_args(args):
    params = args.get("params") or {}
    if not isinstance(params, dict):
        raise QualysToolError("bad_arguments", "params must be an object when provided")
    forbidden_top_level = {"page_size", "truncation_limit", "filter_body", "criteria", "scan_ref"}
    for key in forbidden_top_level:
        if key in args:
            raise QualysToolError("bad_arguments", f"{key} is not supported by VMDR Scan List; use native params plus max_pages only")
    forbidden_params = {
        "filter_body": "GAV filter_body does not apply to VMDR Scan List.",
        "scan_ref": "scan_ref belongs to qualys_vmdr_scan_fetch, not scan list.",
        "qids": "Vulnerability params belong to Host Detection or KnowledgeBase tools, not VMDR Scan List.",
        "qid": "Vulnerability params belong to Host Detection or KnowledgeBase tools, not VMDR Scan List.",
        "ips": "IP scope params belong to VMDR IP List or Host List, not VMDR Scan List unless provider evidence is added.",
        "hostname": "VMDR Scan List is not a free-text host search tool.",
        "host": "VMDR Scan List is not a free-text host search tool.",
    }
    for key in params:
        lower = str(key).lower()
        if lower in forbidden_params:
            raise QualysToolError("bad_arguments", forbidden_params[lower])
    _validate_positive(args, "max_pages")


def _validate_scan_fetch_args(args):
    scan_ref = _required_string(args, "scan_ref")
    normalized = scan_ref.strip().lower()
    if any(token in scan_ref for token in ("<", ">")) or normalized in {
        "scan/123456.789",
        "placeholder",
        "example",
    }:
        raise QualysToolError("bad_arguments", "scan_ref must be a real discovered Qualys scan_ref, not a placeholder")
    params = args.get("params") or {}
    if not isinstance(params, dict):
        raise QualysToolError("bad_arguments", "params must be an object when provided")
    forbidden_top_level = {"page_size", "truncation_limit", "filter_body", "criteria", "max_pages"}
    for key in forbidden_top_level:
        if key in args:
            raise QualysToolError("bad_arguments", f"{key} is not supported by VMDR Scan Fetch; use scan_ref plus optional native params only")
    forbidden_params = {
        "action": "action=fetch is enforced by the hosted tool; do not pass action.",
        "scan_ref": "scan_ref belongs at the top level, not inside params.",
        "filter_body": "GAV filter_body does not apply to VMDR Scan Fetch.",
        "state": "state belongs to qualys_vmdr_scan_list, not scan fetch.",
        "show_last": "show_last belongs to qualys_vmdr_scan_list, not scan fetch.",
    }
    for key in params:
        lower = str(key).lower()
        if lower in forbidden_params:
            raise QualysToolError("bad_arguments", forbidden_params[lower])


def _validate_kb_vuln_args(args):
    params = _native_params_arg(args, required=True)
    forbidden_top_level = {"page_size", "truncation_limit", "status"}
    for key in forbidden_top_level:
        if key in args:
            raise QualysToolError("bad_arguments", f"{key} is not supported by KnowledgeBase vuln list; use params plus max_pages only")
    forbidden_params = {
        "qids": "Use params.ids for KnowledgeBase QID lookup; params.qids belongs to Host Detection.",
        "qid": "Use params.ids for KnowledgeBase QID lookup.",
        "cve_ids": "Use params.cve for KnowledgeBase CVE lookup.",
        "title": "KnowledgeBase title search is not a verified native parameter for this hosted tool.",
        "vulnerability_title": "KnowledgeBase vulnerability title search is not a verified native parameter for this hosted tool.",
        "threat_intelligence": "RTI names are returned metadata for known or bounded QIDs, not verified server-side KB search params.",
        "rti": "RTI names are returned metadata for known or bounded QIDs, not verified server-side KB search params.",
    }
    for key in params:
        lower = str(key).lower()
        if lower in forbidden_params:
            raise QualysToolError("bad_arguments", forbidden_params[lower])
    _validate_positive(args, "max_pages")


def _validate_kb_qvs_args(args):
    params = _native_params_arg(args, required=True)
    forbidden_top_level = {"page_size", "truncation_limit", "status", "max_pages"}
    for key in forbidden_top_level:
        if key in args:
            raise QualysToolError("bad_arguments", f"{key} is not supported by KnowledgeBase QVS list; use bounded params only")
    bounded_keys = {
        "cve",
        "qvs_min",
        "qvs_max",
        "qvs_last_modified_after",
        "qvs_last_modified_before",
        "nvd_published_after",
        "nvd_published_before",
    }
    if not any(str(key).lower() in bounded_keys for key in params):
        raise QualysToolError("bad_arguments", "KnowledgeBase QVS list requires a bounded params filter such as cve, qvs_min, qvs_last_modified_after, or nvd_published_after")
    forbidden_params = {
        "qds_min": "Use Host Detection show_qds/qds_min for QDS; QVS uses qvs_min/qvs_max.",
        "qds_max": "Use Host Detection show_qds/qds_max for QDS; QVS uses qvs_min/qvs_max.",
        "show_qds": "QVS is not Host Detection QDS; remove show_qds.",
        "show_qds_factors": "QVS factors are QVS response metadata, not Host Detection show_qds_factors.",
        "qids": "Use QVS CVE/date/score filters here; Host Detection uses params.qids.",
        "qid": "Use QVS CVE/date/score filters here; Host Detection uses params.qids.",
    }
    for key in params:
        lower = str(key).lower()
        if lower in forbidden_params:
            raise QualysToolError("bad_arguments", forbidden_params[lower])


def _validate_tag_list_args(args):
    extra = set(args) - {"limit"}
    if extra:
        raise QualysToolError("bad_arguments", f"Asset Management tag list accepts only limit; unsupported keys: {', '.join(sorted(extra))}")
    _validate_positive(args, "limit")


def _qps_criteria_list_arg(args, required=False):
    value = args.get("criteria")
    if value is None:
        if required:
            raise QualysToolError("bad_arguments", "criteria is required")
        return []
    if not isinstance(value, list) or not value:
        raise QualysToolError("bad_arguments", "criteria must be a non-empty array")
    allowed_fields = {"id", "name", "created", "modified", "color"}
    criteria = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise QualysToolError("bad_arguments", f"criteria[{index}] must be an object")
        extra = set(item) - {"field", "operator", "value"}
        if extra:
            raise QualysToolError("bad_arguments", f"criteria[{index}] contains unsupported keys: {', '.join(sorted(extra))}")
        field = _criteria_string(item, "field", index)
        operator = _criteria_string(item, "operator", index)
        criteria_value = _criteria_string(item, "value", index)
        if field not in allowed_fields:
            raise QualysToolError("bad_arguments", f"criteria[{index}].field must be one of {', '.join(sorted(allowed_fields))}")
        if criteria_value == "*":
            raise QualysToolError("bad_arguments", 'Do not use "*" for broad Asset Management tag enumeration')
        criteria.append({"field": field, "operator": operator, "value": criteria_value})
    return criteria


def _criteria_string(item, field, index):
    value = item.get(field)
    if not isinstance(value, str) or not value.strip():
        raise QualysToolError("bad_arguments", f"criteria[{index}].{field} must be a non-empty string")
    return value.strip()


def _qps_service_request_xml(criteria, limit=None):
    root = ET.Element("ServiceRequest")
    if limit is not None:
        preferences = ET.SubElement(root, "preferences")
        ET.SubElement(preferences, "limitResults").text = str(limit)
    if not criteria:
        return ET.tostring(root, encoding="unicode")
    filters = ET.SubElement(root, "filters")
    for item in criteria:
        criterion = ET.SubElement(
            filters,
            "Criteria",
            {"field": item["field"], "operator": item["operator"]},
        )
        criterion.text = item["value"]
    return ET.tostring(root, encoding="unicode")


def _parse_qps_service_response(root, record_path):
    records = [_xml_to_obj(elem) for elem in root.findall(record_path)]
    response_code = _first_text(root, ".//responseCode")
    return {
        "results": records,
        "count": len(records),
        "response_code": response_code,
    }


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
        invalid_alias = _gav_filter_invalid_alias(criterion.get("field"))
        if invalid_alias:
            use = invalid_alias.get("use")
            suffix = f"; use {use}" if use else ""
            raise QualysToolError("bad_arguments", f"{field}.filters[{index}].field={criterion.get('field')} is not a supported Qualys GAV filter field: {invalid_alias.get('reason')}{suffix}")
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


def _positive_int_required(args, field):
    value = _positive_int(args, field)
    if value is None:
        raise QualysToolError("bad_arguments", f"{field} is required")
    return value


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


def _required_string(args, field):
    value = _optional_string(args, field)
    if value is None:
        raise QualysToolError("bad_arguments", f"{field} is required")
    return value


def _gav_filter_invalid_alias(value):
    normalized = str(value or "").strip().lower()
    if not normalized:
        return None
    aliases = _gav_filter_vocabulary().get("invalidAliases") or []
    for alias in aliases:
        if not isinstance(alias, dict):
            continue
        if str(alias.get("value") or "").strip().lower() == normalized:
            return alias
    return None


def _gav_filter_vocabulary():
    global _GAV_FILTER_VOCABULARY
    if _GAV_FILTER_VOCABULARY is not None:
        return _GAV_FILTER_VOCABULARY
    try:
        with open("references/gav-filter-fields.json", "r", encoding="utf-8") as handle:
            parsed = json.load(handle)
    except FileNotFoundError as exc:
        raise QualysToolError("bad_arguments", "references/gav-filter-fields.json is required for GAV filter validation") from exc
    if not isinstance(parsed, dict) or parsed.get("kind") != "openacme.hostedParameterVocabulary":
        raise QualysToolError("bad_arguments", "references/gav-filter-fields.json is not an OpenAcme hosted parameter vocabulary")
    _GAV_FILTER_VOCABULARY = parsed
    return _GAV_FILTER_VOCABULARY


def _validate_string_list(value, field):
    if value is not None and (not isinstance(value, list) or not all(isinstance(item, str) and item.strip() for item in value)):
        raise QualysToolError("bad_arguments", f"{field} must be an array of non-empty strings")


def _optional_string_list(value, field):
    _validate_string_list(value, field)
    return value or None


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
