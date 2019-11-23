// zoteroocr.js

// See https://developer.mozilla.org/en-US/docs/Mozilla/JavaScript_code_modules.
Components.utils.import("resource://gre/modules/FileUtils.jsm");
Components.utils.import("resource://gre/modules/osfile.jsm");

Zotero.OCR = new function() {

	this.openPreferenceWindow = function(paneID, action) {
		var io = {pane: paneID, action: action};
		
		window.openDialog(
				'chrome://zoteroocr/content/preferences.xul',
				'Zotero OCR Preferences',
				'chrome,titlebar,toolbar,centerscreen' + Zotero.Prefs.get('browser.preferences.instantApply', true) ? 'dialog=no' : 'modal', io
		);
	};

	this.recognize = Zotero.Promise.coroutine(function* () {

		// Look for the tesseract executable in the settings and at commonly used locations.
		// If it is found, the settings are updated.
		// Otherwise abort with an alert.
		let ocrEngine = Zotero.Prefs.get("zoteroocr.ocrPath");
		let found = false;
		if (ocrEngine) {
			found = yield OS.File.exists(ocrEngine);
		} else {
			let path = ["/usr/local/bin/", "/usr/bin/", "C:\\Program Files\\Tesseract-OCR\\", ""];
			for (ocrEngine of path) {
				ocrEngine += "tesseract"
				if (Zotero.isWin) {
					ocrEngine += ".exe"
				}
				if (yield OS.File.exists(ocrEngine)) {
					found = true;
					Zotero.debug("Found " + ocrEngine);
					Zotero.Prefs.set("zoteroocr.ocrPath", ocrEngine);
					break;
				}
				Zotero.debug("No " + ocrEngine);
			}
		}
		if (!found) {
			alert("No " + ocrEngine + " executable found.");
			return;
		}

		// Look for pdfinfo and pdftoppm in the same directory as the zotero executable.
		// Abort with an alert if they are not found.
		// See https://developer.mozilla.org/en-US/docs/Archive/Add-ons/Code_snippets/File_I_O#Getting_special_files
		// and https://dxr.mozilla.org/mozilla-central/source/xpcom/io/nsDirectoryServiceDefs.h.
		let dir = FileUtils.getDir('GreBinD', []);
		let pdfinfo = dir.clone();
		pdfinfo.append("pdfinfo");
		pdfinfo = pdfinfo.path;
		let pdftoppm = dir.clone();
		pdftoppm.append("pdftoppm");
		pdftoppm = pdftoppm.path;
		if (Zotero.isWin) {
			pdfinfo = pdfinfo + ".exe";
			pdftoppm = pdftoppm + ".exe";
		}
		if (!(yield OS.File.exists(pdfinfo))) {
			alert("No " + pdfinfo + " executable found.");
			return;
		}
		if (!(yield OS.File.exists(pdftoppm))) {
			alert("No " + pdftoppm + " executable found.");
			return;
		}

		let items = Zotero.getActiveZoteroPane().getSelectedItems();
		for (let item of items) {
			// find the PDF
			let pdfItem;
			if (item.isAttachment()) {
				if (item.isFileAttachment() && item.attachmentContentType == 'application/pdf') {
					pdfItem = item;
					item = Zotero.Items.get(item.parentItemID);
				} else {
					alert("Item is attachment but not PDF and will be ignored.");
					continue;
				}
			} else {
				let pdfAttachments = item.getAttachments(false)
					.map(itemID => Zotero.Items.get(itemID))
					.filter(att => att.isFileAttachment() && att.attachmentContentType == 'application/pdf');
				if (pdfAttachments.length == 0) {
					alert("No PDF found for the selected item.");
					continue;
				}
				if (pdfAttachments.length > 1) {
					alert("There are several PDFs attached to this item. Only the first one will be processed.");
				}
				pdfItem = pdfAttachments[0];
			}
			let pdf = pdfItem.getFilePath();
			let base = pdf.replace(/\.pdf$/, '');
			let dir = OS.Path.dirname(pdf);
			let infofile = base + '.info.txt';
			let ocrbase = base + '.ocr';
			// TODO filter out PDFs which have already a text layer

			// extract images from PDF
			let imageList = OS.Path.join(dir, 'image-list.txt');
			if (!(yield OS.File.exists(imageList))) {
				try {
					Zotero.debug("Running " + pdfinfo + ' ' + pdf + ' ' + infofile);
					yield Zotero.Utilities.Internal.exec(pdfinfo, [pdf, infofile]);
					Zotero.debug("Running " + pdftoppm + ' -png -r 300 ' + pdf + ' ' + dir + '/page');
					yield Zotero.Utilities.Internal.exec(pdftoppm, ['-png', '-r', 300, pdf, dir + '/page']);
				}
				catch (e) {
					Zotero.logError(e);
				}
				// save the list of images in a separate file
				let info = yield Zotero.File.getContentsAsync(infofile);
				let numPages = info.match('Pages:[^0-9]+([0-9]+)')[1];
				let imageListString = '';
				for (let i=1; i<=parseInt(numPages, 10); i++) {
					let paddedIndex = "0".repeat(numPages.length) + i;
					imageListString += dir + '/page-' + paddedIndex.substr(-numPages.length) + '.png\n';
				}
				Zotero.File.putContents(Zotero.File.pathToFile(imageList), imageListString);
			}

			try {
				// TODO Is the differentiation for the output files with the additional '.ocr' useful in the end?
				// Or should we overwrite the PDF and simplify the name of the hocr file?
				Zotero.debug("Running " + ocrEngine + ' ' + dir + '/image-list.txt ' + ocrbase + ' hocr txt pdf');
				yield Zotero.Utilities.Internal.exec(ocrEngine, [dir + '/image-list.txt', ocrbase, 'hocr', 'txt', 'pdf']);
			}
			catch (e) {
				Zotero.logError(e);
			}

			// add note with full text
			// TODO is this useful at all?
			let contents = yield Zotero.File.getContentsAsync(ocrbase + '.txt');
			let newNote = new Zotero.Item('note');
			newNote.setNote(contents);
			newNote.parentID = item.id;
			yield newNote.saveTx();

			// create attachments with link to output formats
			for (let format of ['pdf', 'hocr']) {
				yield Zotero.Attachments.linkFromFile({
					file: ocrbase + '.' + format,
					parentItemID: item.id
				});
			}
		}
	});
};
