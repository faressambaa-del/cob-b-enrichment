{
  "actorSpecification": 1,
  "name": "cobb-county-jail-inquiry-scraper",
  "title": "Cobb County Jail Inquiry Scraper",
  "description": "Searches Cobb County jail roster in Inquiry mode with WebShare rotating proxies",
  "version": "1.0",
  "input": {
    "title": "Scraper Input",
    "type": "object",
    "schemaVersion": 1,
    "properties": {
      "name": {
        "title": "Inmate Name",
        "description": "Full name in 'Last First' format e.g. Smith John",
        "type": "string",
        "editor": "textfield"
      },
      "soid": {
        "title": "SOID Number (optional)",
        "description": "SOID number for faster lookup",
        "type": "string",
        "editor": "textfield"
      },
      "serial": {
        "title": "Serial Number (optional)",
        "description": "Serial number for lookup",
        "type": "string",
        "editor": "textfield"
      },
      "mode": {
        "title": "Search Mode",
        "description": "Inquiry for broader search, In Custody for current inmates only",
        "type": "string",
        "editor": "select",
        "enum": ["Inquiry", "In Custody"],
        "default": "Inquiry"
      },
      "proxyUsername": {
        "title": "WebShare Proxy Username",
        "description": "Your WebShare proxy username",
        "type": "string",
        "editor": "textfield"
      },
      "proxyPassword": {
        "title": "WebShare Proxy Password",
        "description": "Your WebShare proxy password",
        "type": "string",
        "editor": "textfield",
        "isSecret": true
      },
      "proxyList": {
        "title": "Proxy List",
        "description": "Array of proxy IPs with ports e.g. [\"12.34.56.78:8080\", \"23.45.67.89:8080\"]",
        "type": "array",
        "editor": "json",
        "default": []
      }
    },
    "required": ["name"]
  }
}
