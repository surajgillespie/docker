// # docker.js
// ## _A simple documentation generator based on [docco](http://jashkenas.github.com/docco/)_
// **Docker** is a really simple documentation generator, which originally started out as a
// pure-javascript port of **docco**, but which eventually gained many extra little features (and
// there are plenty more to come) which somewhat break docco's philosophy of being a quick-and-dirty
// thing.
//
// Docker source-code can be found on [GitHub](https://github.com/jbt/docker)
//
// Take a look at the [original docco project](http://jashkenas.github.com/docco/) to get a feel
// for the sort of functionality this provices. In short: **Markdown**-based displaying of code comments
// next to syntax-highlighted code. This page is the result of running docker against itself.
//
// The command-line usage of docker is somewhat more useful than that of docco. To use, simply run
//
// ```
// ./docker -i path/to/code -o path/to/docs file1.js file2.js
// ```
//
// Docker will then recurse into the code root directory and document-ize all the files it can.
// The folder structure will be preserved in the document root.
//
// ## jsDoc support
// The main difference from docco is the added support for **jsDoc**-style code comments, which
// is provided by way of [Dox](https://github.com/visionmedia/dox). You can see some examples of
// the sort of output you get below.
//
//
// So let's get started!


// ## Node Modules
// Include all the necessay node modules.
var mkdirp = require('mkdirp'),
  fs = require('fs'),
  dox = require('dox'),
  path = require('path'),
  spawn = require('child_process').spawn,
  showdown = require('../lib/showdown').Showdown;

/**
 * ## Docker Constructor
 *
 * Creates a new docker instance. All methods are called on one instance of this object.
 *
 * @constructor
 * @this {Docker}
 * @param {string} inDir The root directory containing all the code files
 * @param {string} outDir The directory into which to put all the doc pages
 */
var Docker = module.exports =function(inDir, outDir){
  this.inDir = inDir.replace(/\/$/,'');
  this.outDir = outDir;
  this.running = false;
  this.fileQueue = [];
};

/**
 * ## Docker.prototype.doc
 *
 * Generate documentation for a bunch of files
 *
 * @this Docker
 * @param {Array} files Array of file paths relative to the `inDir` to generate documentation for.
 */
Docker.prototype.doc = function(files){
  for(var i = 0; i < files.length; i += 1){
    this.docFile(files[i]);
  }
};

/**
 * ## Docker.prototype.docFile
 *
 * Generate documentation for a particular file.
 *
 * Checks to see if the given filename is actually a directory, and if it is,
 * then finds all children and queues those. Otherwise, queues the file for generation
 *
 * @this Docker
 * @param {string} filename File name relative to `inDir` to generate documentation for
 */
Docker.prototype.docFile = function(filename){
  var self = this;
  fs.stat(path.join(this.inDir, filename), function(err, stat){
    // If the file we have is actually a directory, find all the files
    // in that directory and queue those as well.
    if(stat && stat.isDirectory()){
      fs.readdir(path.join(self.inDir, filename), function(err, list){
        var files = [];
        for(var i = 0; i < list.length; i += 1){
          files.push(path.join(filename, list[i]));
        }
        self.doc(files);
      });
    }else{
      // Otherwise, just queue the file
      self.queueFile(filename);
    }
  });
};

/**
 * ## Docker.prototype.queueFile
 *
 * Queue a file for documentation generation.
 *
 * As docker uses a few asynchronous processes, instead of immediately
 * rushing off and generate documentation for all files as soon as we
 * get them, put them in a queue and loop through them one-by-one
 *
 * @this Docker
 * @param {string} filename File name to queue for documentation
 */
Docker.prototype.queueFile = function(filename){
  // If we can't actually process the file, ignore it
  if(!this.canHandleFile(filename)) return;
  this.fileQueue.push(filename);

  // If we're not actually in the process of generating documentation, start.
  if(!this.running) this.nextFile();
};

/**
 * ## Docker.prototype.nextFile
 *
 * Take the next file off the queue and process it
 */
Docker.prototype.nextFile = function(){
  var self = this;

  // If we still have files on the queue, process the first one
  if(this.fileQueue.length > 0){
    this.generateDoc(this.fileQueue.shift(), function(){
      self.nextFile();
    });
  }else{
    // If there are no files left, then flag that we've stopped running
    this.running = false;
  }
};

/**
 * ## Docker.prototype.canHandleFile
 *
 * Check to see whether or not we can process a given file
 * For now, we can only do javascript files
 *
 * @param {string} filename File name to test
 */
Docker.prototype.canHandleFile = function(filename){
  return path.extname(filename) == '.js';
};

/**
 * ## Docker.prototype.generateDoc
 * ### _This is where the magic happens_
 *
 * Generate the documentation for a file
 *
 * @param {string} filename File name to generate documentation for
 * @param {function} cb Callback function to execute when we're done
 */
Docker.prototype.generateDoc = function(filename, cb){
  var self = this;
  this.running = true;
  filename = path.join(this.inDir, filename);
  fs.readFile(filename, 'utf-8', function(err, data){
    if(err) throw err;
    var sections = self.parseSections(data, filename);
    self.highlight(sections, filename, function(){
      self.renderHtml(sections, filename, cb);
    });
  });
};

/**
 * ## Docker.prototype.parseSections
 *
 * Parse the content of a file into individual sections.
 * A section is defined to be one block of code with an accompanying comment
 *
 * Returns an array of section objects, which take the form
 * ```
 *  {
 *    doc_text: 'foo', // String containing comment content
 *    code_text: 'bar' // Accompanying code
 *  }
 * ```
 * @param {string} data The contents of the script file
 * @param {string} filename The name of the script file
 * @return {Array} array of section objects
 */
Docker.prototype.parseSections = function(data, filename){
  var codeLines = data.split('\n');
  var sections = [];

  // Fetch language-specific parameters for this code file
  var params = this.languageParams(filename);
  var section = {
    docs: '',
    code: ''
  };
  var inMultiLineComment = false;
  var multiLine = '';
  var doxData;

  // Loop through all the lines, and parse into sections
  for(var i = 0; i < codeLines.length; i += 1){
    var line = codeLines[i];

    // If we are currently in a multiline comment, behave differently
    if(inMultiLineComment){
      if(line.match(params.multilineEnd)){
        // Once we have reached the end of the multiline, take the whole content
        // of the multiline comment, and pass it through **dox**, which will then
        // extract any **jsDoc** parameters that are present.
        multiLine += line + '\n';
        inMultiLineComment = false;
        try{
          doxData = dox.parseComments(multiLine)[0];
          section.docs += this.doxTemplate(doxData);
        }catch(e){
          console.log("Dox error: " + e);
          section.docs += multiLine;
        }
        multiLine = '';
      }else{
        multiLine += line + '\n';
      }
    }else if(line.match(params.multilineStart) && !line.match(params.multilineEnd)){
      // Here we start parsing a multiline comment. Store away the current section and start a new one
      if(section.code){
        if(!section.code.match(/^\s*$/) || !section.docs.match(/^\s*$/)) sections.push(section);
        section = { docs: '', code: '' };
      }
      inMultiLineComment = true;
      multiLine = line;
    }else if(line.match(params.commentRegex) && !line.match(params.commentsIgnore)){
      // This is for single-line comments. Again, store away the last section and start a new one
      if(section.code){
        if(!section.code.match(/^\s*$/) || !section.docs.match(/^\s*$/)) sections.push(section);
        section = { docs: '', code: '' };
      }
      section.docs += line.replace(params.commentRegex, '') + '\n';
    }else if(!line.match(params.commentsIgnore)){
      section.code += line + '\n';
    }
  }
  sections.push(section);
  return sections;
};

/**
 * ## Docker.prototype.languageParams
 *
 * Provides language-specific params for a given file name.
 *
 * @param {string} filename The name of the file to test
 * @return {object} Object containing all of the language-specific params
 */
Docker.prototype.languageParams = function(filename){
  switch(path.extname(filename)){
    case '.js':
      // `commentRegex` is for single-line comments, `multilineStart` and `multilineEnd` are for multiline comments
      // `commentsIgnore` is for comments that should be stripped completely and not document-ized.
      // `divText` is a generic divider so sections can be fed into **pygments** together
      // `divHtml` is the corresponding divider to look for in the output
      return {
        name: 'javascript',
        comment: '//',
        commentRegex: /^\s*\/\/\s?/,
        commentsIgnore: /^\s*\/\/=/,
        multilineStart: /\/\*/,
        multilineEnd: /\*\//,
        divText: '\n//----{DIVIDER_THING}----\n',
        divHtml: /\n*<span class="c1?">\/\/----\{DIVIDER_THING\}----<\/span>\n*/
      };
    // Currently we only support javascript. If we've got here without
    // already having skipped or thrown an error, something's gone wrong.
    default:
      throw 'Unknown language';
  }
};

/**
 * ## Docker.prototype.highlight
 *
 * Highlights all the sections of a file using **pygments**
 * Given an array of section objects, loop through them, and for each section,
 * generate pretty html for the comments and the code, and put them in
 * `docHtml` and `codeHtml` respectively
 *
 * @param {Array} sections Array of section objects
 * @param {string} filename Name of the file being processed
 * @param {function} cb Callback function to fire when we're done
 */
Docker.prototype.highlight = function(sections, filename, cb){
  var params = this.languageParams(filename);

  // Spawn a new **pygments** process
  var pyg = spawn('pygmentize', ['-l', params.name, '-f', 'html', '-O', 'encoding=utf-8,tabsize=2']);

  // Hook up errors, for either when pygments itself throws an error,
  // or for when we're unable to send the code to pygments for some reason
  pyg.stderr.on('data', function(err){ console.error(err); });
  pyg.stdin.on('error', function(err){
    console.error('Unable to write to Pygments stdin: ' , err);
    process.exit(1);
  });

  var out = '';
  pyg.stdout.on('data', function(data){ out += data.toString(); });

  // Once pygments is done, split the output up into different sections, and
  // allocate them to the relevant section objects.
  // Also parse the comment text using **showdown**
  pyg.on('exit', function(){
    out = out.replace(/^\s*<div class="highlight"><pre>/,'').replace(/<\/pre><\/div>\s*$/,'');
    var bits = out.split(params.divHtml);
    for(var i = 0; i < sections.length; i += 1){
      sections[i].codeHtml = '<div class="highlight"><pre>' + bits[i] + '</pre></div>';
      sections[i].docHtml = showdown.makeHtml(sections[i].docs);
    }
    cb();
  });

  // Feed pygments with the code
  if(pyg.stdin.writable){
    var input = [];
    for(var i = 0; i < sections.length; i += 1){
      input.push(sections[i].code);
    }
    pyg.stdin.write(input.join(params.divText));
    pyg.stdin.end();
  }
};


/**
 * ## Docker.prototype.renderHtml
 *
 * Given an array of sections, render them all out to a nice HTML file
 *
 * @param {Array} sections Array of sections containing parsed data
 * @param {string} filename Name of the file being processed
 * @param {function} cb Callback function to fire when we're done
 */
Docker.prototype.renderHtml = function(sections, filename, cb){

  // Decide which path to store the output on.
  var outFile = this.outFile(filename);

  // Calculate the location of the input root relative to the output file.
  // This is necessary so we can link to the stylesheet in the output HTML using
  // a relative href rather than an absolute one
  var outDir = path.dirname(outFile);
  var relDir = '';
  while(path.join(outDir, relDir).replace(/\/$/,'') !== this.outDir.replace(/\/$/,'')){
    relDir += '../';
  }

  // Render the html file using our template
  var html = this.renderTemplate({
    title: path.basename(filename),
    sections: sections,
    relativeDir: relDir
  });

  var self = this;

  // Recursively create the output directory, clean out any old version of the
  // output file, then save our new file.
  mkdirp(outDir, function(){
    fs.unlink(outFile, function(){
      fs.writeFile(outFile, html, function(){
        console.log('Generated: ' + outFile.replace(self.outDir,''));
        cb();
      });
    });
  });

  // Copy in the CSS file for our output if it doesn't already
  // exist in the output directory.
  fs.stat(path.join(this.outDir, 'doc-style.css'), function(err, stat){
    if(err){
      fs.readFile(path.join(path.dirname(__filename),'../res/style.css'), function(err, file){
        fs.writeFile(path.join(self.outDir, 'doc-style.css'), file);
      });
    }
  });
};

/**
 * ## Docker.prototype.outFile
 *
 * Generates the output path for a given input file
 *
 * @param {string} filename Name of the input file
 * @return {string} Name to use for the generated doc file
 */
Docker.prototype.outFile = function(filename){
  return filename.replace(this.inDir, this.outDir) + '.html';
};

/**
 * ## Docker.prototype.compileTemplate
 *
 * Tiny template compilation function
 *
 * @param {string} str Template content
 * @return {function} Compiled template function
 */
Docker.prototype.compileTemplate = function(str){
  return new Function('obj', 'var p=[],print=function(){p.push.apply(p,arguments);};' +
    'with(obj){p.push(\'' +
    str.replace(/[\r\t\n]/g, " ")
         .replace(/'(?=[^<]*%>)/g, "\t")
         .split("'").join("\\'")
         .split("\t").join("'")
         .replace(/<%=(.+?)%>/g, "',$1,'")
         .split('<%').join("');")
         .split('%>').join("p.push('") +
    "');}return p.join('');");
};

/**
 * ## Docker.prototype.renderTemplate
 *
 * Renders the HTML for an output page with given parameters
 *
 * @param {object} obj Object containing parameters for the template
 * @return {string} Rendered doc page
 */
Docker.prototype.renderTemplate = function(obj){
  // If we haven't already loaded the template, load it now.
  // It's a bit messy to be using readFileSync I know, but this
  // is the easiest way for now.
  if(!this.__tmpl){
    var tmplFile = path.join(path.dirname(__filename),'../res/tmpl.jst');
    this.__tmpl = this.compileTemplate(fs.readFileSync(tmplFile).toString());
  }
  return this.__tmpl(obj);
};

/**
 * ## Docker.prototype.doxTemplate
 *
 * Renders the output of **dox** into a format suitable for compilation
 *
 * @param {object} obj Object containing output of dox
 * @return {string} Rendered output of dox properties
 */
Docker.prototype.doxTemplate = function(obj){
  if(!this.__doxtmpl){
    var tmplFile = path.join(path.dirname(__filename), '../res/dox.jst');
    this.__doxtmpl = this.compileTemplate(fs.readFileSync(tmplFile).toString());
  }
  return this.__doxtmpl(obj);
};