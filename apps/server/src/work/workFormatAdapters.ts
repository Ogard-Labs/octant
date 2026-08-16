/**
 * Production adapter barrel. Import this module from the server initialization
 * path to register all built-in Work format adapters for side-effect. Each
 * adapter self-registers via `registerWorkFormatAdapter` at module load.
 */
import "./workDocxAdapter";
import "./workImageAdapter";
import "./workPdfAdapter";
import "./workPptxAdapter";
import "./workXlsxAdapter";
