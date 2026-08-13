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
tools:
  - name: qualys_gav_asset_count
    title: Qualys GAV Asset Count
    description: Source-backed port of legacy integration-hub Qualys count_assets for CSAM/GAV asset counts.
    inputSchema:
      type: object
      additionalProperties: true
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
  - name: qualys_gav_asset_search
    title: Qualys GAV Asset Search
    description: Source-backed port of legacy integration-hub Qualys list_assets for CSAM/GAV asset search.
    inputSchema:
      type: object
      additionalProperties: true
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
  - name: qualys_cloud_agent_hostasset_count
    title: Qualys Cloud Agent Hostasset Count
    description: Source-backed Qualys Cloud Agent count using CSAM/GAV asset.trackingMethod EQUALS QAGENT filter semantics.
    inputSchema:
      type: object
      additionalProperties: true
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
  - name: qualys_cloud_agent_hostasset_search
    title: Qualys Cloud Agent Hostasset Search
    description: Source-backed Qualys Cloud Agent search using CSAM/GAV asset.trackingMethod EQUALS QAGENT filter semantics.
    inputSchema:
      type: object
      additionalProperties: true
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
  - name: qualys_vmdr_host_list
    title: Qualys VMDR Host List
    description: Source-backed port of legacy integration-hub Qualys list_hosts for VMDR Host List API v5.
    inputSchema:
      type: object
      additionalProperties: true
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
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

Credentials and endpoints come from hosted integration config scopes and
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


def call_tool(name, args, context):
    args = args or {}
    if name == "qualys_vmdr_host_list":
        _validate_host_list_args(args)
        client = QualysClient(context)
        return client.list_hosts(
            truncation_limit=args.get("truncation_limit"),
            params=_native_params_arg(args),
            max_pages=_positive_int(args, "max_pages"),
        )

    if name == "qualys_gav_asset_count":
        client = QualysClient(context)
        return client.count_assets(
            asset_last_updated=_optional_string(args, "asset_last_updated"),
            filter_body=_gateway_filter_body_arg(args, allow_filter_xml=True),
            filter_xml=_gateway_filter_xml_arg(args),
            last_seen_asset_id=_positive_int(args, "last_seen_asset_id"),
        )

    if name == "qualys_gav_asset_search":
        client = QualysClient(context)
        return _list_assets_from_args(client, args)

    if name == "qualys_cloud_agent_hostasset_count":
        client = QualysClient(context)
        return client.count_assets(
            asset_last_updated=_optional_string(args, "asset_last_updated"),
            filter_body=_qagent_filter_body(args),
            filter_xml=None,
            last_seen_asset_id=_positive_int(args, "last_seen_asset_id"),
        )

    if name == "qualys_cloud_agent_hostasset_search":
        client = QualysClient(context)
        return _list_assets_from_args(client, {**args, "filter_body": _qagent_filter_body(args)})

    raise ValueError(f"unknown tool: {name}")


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
        raw = self._request_bytes(req, "Qualys Gateway").decode("utf-8", errors="replace")
        stripped = raw.strip()
        if not stripped:
            raise QualysToolError("upstream_error", "Qualys Gateway returned an empty asset search response")
        if stripped.startswith("<"):
            try:
                parsed = _xml_to_obj(ET.fromstring(stripped))
            except ET.ParseError as exc:
                raise QualysToolError("upstream_error", f"Could not parse Qualys Gateway XML response: {exc}; first 300 chars: {raw[:300]}")
            return parsed if isinstance(parsed, dict) else {"response": parsed}
        try:
            return json.loads(stripped)
        except json.JSONDecodeError as exc:
            raise QualysToolError("upstream_error", f"Could not parse Qualys Gateway JSON response: {exc}; first 300 chars: {raw[:300]}")

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

    def _request_bytes(self, req, service, parse_xml_cooldown=False):
        try:
            with urlopen(req, timeout=self.timeout, context=self._ssl_context()) as resp:
                body = resp.read()
        except HTTPError as exc:
            body_txt = exc.read().decode("utf-8", errors="replace")
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
    has_tracking = any(str(item.get("field", "")).lower() == "asset.trackingmethod" for item in filters)
    return {**base, "filters": ([QAGENT_FILTER] if not has_tracking else []) + filters}


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
    search_body = args.get("search_body")
    filter_body = args.get("filter_body")
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
