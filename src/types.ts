export interface ScrapRequest {
  name: string;
}

export interface Charge {
  warrant?: string;
  warrantDate?: string;
  case?: string;
  otn?: string;
  offenseDate?: string;
  codeSection?: string;
  description?: string;
  type?: string;
  counts?: string;
  bond?: string;
  disposition?: string;
}

export interface ArrestCircumstances {
  arrestAgency?: string;
  officer?: string;
  locationOfArrest?: string;
  serialNumber?: string;
}

export interface InmateData {
  event_id: string;        // SOID - required by your n8n workflow
  soId: string;
  name?: string;
  dob?: string;
  raceSex?: string;
  location?: string;
  daysInCustody?: string;
  height?: string;
  weight?: string;
  hair?: string;
  eyes?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  placeOfBirth?: string;
  agencyId?: string;
  arrestDateTime?: string;
  bookingStarted?: string;
  bookingComplete?: string;
  visibleScarsMarks?: string;
  arrestCircumstances?: ArrestCircumstances;
  charges?: Charge[];
  bondAmount?: string;
  bondStatus?: string;
  releaseDate?: string;
  releaseOfficer?: string;
  releasedTo?: string;
  attorney?: string;
  bookingId?: string;
  [key: string]: any;
}

export interface ScrapResponse {
  success: boolean;
  found: boolean;
  data?: InmateData;
  error?: string;
  message?: string;
}
