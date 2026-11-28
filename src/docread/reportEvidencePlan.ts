import type {IndexedReportPage} from "./pageSelectionIndex";

// A cheap shortlist for an optional local model run. Include pages that carry both kinds of
// evidence even if the index displays just one role. The picker also offers the full native index.
export function likelyEvidencePages(pages:readonly IndexedReportPage[],goal:"both"|"log"|"schedule"):IndexedReportPage[]{
  return pages.filter(({role,lines})=>{
    if(!lines.length)return false;
    if((goal!=="schedule"&&role==="log")||(goal!=="log"&&role==="schedule"))return true;
    const text=lines.join(" ");
    // Measured numeric ranges can occur in a figure captioned below a long narrative.
    const interval=/\b\d+(?:[.,]\d+)?\s*[-–—]\s*\d+(?:[.,]\d+)?\s*(?:m|ft)\b/i;
    if(goal!=="schedule"&&interval.test(text)&&/\b(?:litholog\w*|graphic log|soil description|borehole log)\b|柱状図/i.test(text))return true;
    // A log can repeat the measured collar, including a table whose coordinate labels are on separate rows.
    if(role==="planned"&&!lines.some(l=>/\b(?:as[- ]drilled|as[- ]built|surveyed|actual)\s+(?:collar\s+)?(?:position|location|coordinates?|eastings?|northings?|latitude|longitude)\b/i.test(l)))return false;
    const pair=/\beastings?\b/i.test(text)&&/\bnorthings?\b/i.test(text)||
      /\blatitude\b/i.test(text)&&/\blongitude\b/i.test(text);
    return goal!=="log"&&pair&&/\d{4}/.test(text);
  });
}
