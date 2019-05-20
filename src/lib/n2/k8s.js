'use strict'
// Imports the Google Cloud client library
import {Netmask} from 'netmask'
import pem from 'pem'
import shell from 'shelljs'
import Range from 'range'
import fs from 'fs'
import ejs from 'ejs'
import { Base64 } from 'js-base64'
import RandomString from 'randomstring'
import jws from 'jws'

const range = (start, end) => (end) ? Range.range(start, end + 1) : [],
      FILES = {
	  controller: ['etcd.service',
		       'kube-apiserver.service',
		       'kube-controller-manager.service',
		       'kube-scheduler.service',
		       'encryption-config.yaml',
		       'kube-scheduler.yaml',
		       'kube-proxy-rbac.yaml',
		       'kubelet.yaml',
		       'kubernetes.yaml',
		       'bootstrappers.yaml',
		       'healthz.conf',
		       'controller.sh'
		      ],
	  worker:  ['10-bridge.conf',
		    '99-loopback.conf',
		    'config.toml',
		    'containerd.service',
		    'daemon.json',
		    'kubelet-config.yaml',
		    'kubelet.service',
		    'kube-proxy-config.yaml',
		    'kube-proxy.service',
		    'worker.sh',
		   ]
      }

class K8S {
    constructor(config) {
	this.config = config
	this.cloud = {
	    network: null,
	    subnet: null,
	    instances: null,
	    forwarding: null
	}
	let methods = ['create_certificate', 'create_certificates',
	 'create_context', 'create_contexts',
	 'forwardingIP',
	 'status',
	 'storeStatus',
	 'renderVars',
	 'render',
	 'renderFile'
		      ]
	methods.map(method => this[method] = this[method].bind(this))
    }

    // UTILITIES
    roleRange(type) {
	let count = this.config.cluster[type + 's'].count
	return count ? range(1, count) : []
    }
    
    randomBase64(chars=32) {
	return Base64.encode(RandomString.generate({
	    length: 32
	}))
    }

    controllers() {
	return this.instanceNames('controller')
    }
    workers() {
	return this.instanceNames('worker')
    }
    count(instance, type) {
	let {config} = this,
	    {cluster} = config
	return cluster[type + 's'].count
	    
    }
    renderVars() {
	let {config} = this,
	    methods = {
		random: _ => this.randomBase64(_),
		base64: Base64,
		range: (start, end) => this.range(start, end),
		count: (type) => this.count(type),
		config,
		cluster: config.cluster,
		ports: config.cluster.ports,
		controllers: _ => this.controllers(),
		publicIP: (type,num) => this.publicIP(type,num),
		privateIP: (type,num) => this.privateIP(type,num),
		instanceCIDR: (type,num) => this.instanceCIDR(type,num),
		forwardingIP: (type) => this.forwardingIP(type),
		instanceName: (type, num) => this.instanceName(type),
		subnetCidr: () => this.subnetCidr(),
	    }
	Object
	    .keys(methods)
	    .filter(_ => typeof(methods[_]) == 'function')
	    .map(_ =>  methods[_] = methods[_].bind(this))
	return methods
    }
    render(file, data) {
	data = Object.assign(this.renderVars(), data)
	return new Promise((res, rej) => ejs
			   .renderFile(file,
				       data,
				       {},
				       (err, data) => err
				       ? rej(err)
				       : res(data)
				      ))
    }
    
    renderFile(file, data, outfile) {
	outfile = 'files/' + (outfile
			      ? outfile
			      : file.replace(/\.?ejs\/?/g, ''))
	return this
	    .render(`ejs/${file}.ejs`,data)
	    .then(data => new Promise(
		(res, rej) => fs.writeFile(outfile,
					   data,
					   err => err ? rej(err) : res(true))))
    }

    // OPERATORS
    exec(cmd, opts={}) {
	console.info(cmd)
	try {
	    let res = shell.exec(cmd, {silent: opts.silent})
	    // if (res.stdout) console.info(res.stdout)
	    // if (res.stderr) console.error(res.stderr)
	    return Promise.resolve(res.stdout.replace(/\r?\n$/, ''))
	} catch (e) {
	    return Promise.reject(e)
	}
    }

    compute(subcmd, args) {
	let verbosity = (subcmd || '').match(/ deleteDISABLED /i)
	    ? '--verbosity=critical'
	    : '',
	    cmd = `gcloud compute -q ${verbosity} ${subcmd}`
	return this.exec(cmd, args)
    }

    computeJSON(cmd, args) {
	return this
	    .compute(`${cmd} --format=json`, args)
	    .then(json => {
		try {
		    return Promise.resolve(JSON.parse(json))
		} catch (e) {
		    return Promise.reject(e)
		}
	    })
    }
    
    // DESCRIPTORS
    fetchInstance(name) {
	// networkInterfaces[0].networkIP,metadata.items[0].value)'
	return this
	    .computeJSON(`instances describe ${name}`)
	    .catch(_ => null)
    }

    fetchInstances() {
	let instances = this
	    .instanceNames()
	    .map(name => this.fetchInstance(name))

	return Promise
	    .all(instances)
	    .then(instances => instances
		  .map(instance => instance ? ({[instance['name']]: instance}) : {})
		  .reduce((sum, next) => Object.assign({}, sum, next), {})
		 )
	    .catch(err => {
		console.error(err)
	    })
    }

    fetchForwarding(name) {
	let {app, cluster} = this.config,
	    {region} = cluster
	return this
	    .computeJSON(`forwarding-rules describe ${name || (app + '-api')} `
			 + `--region=${region}`,
			 {silent: true})
	    .catch(_ => null)
	    .then(_ => _)
    }
    
    fetchNetwork() {
	let {app} = this.config
	return this
	    .computeJSON(`networks describe ${app} `, {silent: true})
	    .catch(_ => null)
	    .then(_ => _)
    }
    
    fetchSubnet() {
	let {app} = this.config,
	    {region} = this.config.cluster
	return this
	    .computeJSON(`networks subnets describe ${app} `
			 + `--region=${region}`, {silent: true})
	    .catch(_ => null)
	    .then(_ => _)
    }

    fetch() {
	return Promise.all(
	    [this.fetchNetwork(),
	     this.fetchSubnet(),
	     this.fetchInstances(),
	     this.fetchForwarding('api'),
	     this.fetchForwarding('health'),
	    ]
	).then(
	    ([network, subnet,
	      instances, forwardingAPI, forwardingHealth]) => {
		  return this.cloud = {
		      network,
		      subnet,
		      instances,
		      forwarding: {
			  api: forwardingAPI,
			  health: forwardingHealth
		      }
		      
		  }
	      }
	)
    }
    
    instanceName(type, num) {
	let config = this.config.cluster[type + 's']
	return  `${config.prefix || type}-${num}`
    }
    instance(type, num) {
	let {cloud} = this
	return cloud && cloud.instances[this.instanceName(type,num)]
    }
    instances() {
	let {cloud} = this
	return cloud && cloud.instances
    }

    instanceNames(type) {
	if (type) return this
	    .roleRange(type)
	    .filter(_ => _)
	    .map(count => this.instanceName(type, count))
	
	let workers = this.instanceNames('worker'),
	    controllers = this.instanceNames('controller')
	return controllers.concat(workers)
    }

    networkInterface(name) {
	let {cloud} = this,
	    instance = cloud && cloud.instances && cloud.instances[name],
	    ifaces = instance && instance.networkInterfaces
	return (ifaces && ifaces.length) ? ifaces[0] : null
    }

    instancePublicIP(name) {
	let iface = this.networkInterface(name),
	    config = iface && iface.accessConfigs && iface.accessConfigs[0]
	return config ? config['natIP'] : null
    }
    instancePrivateIP(name) {
	let iface = this.networkInterface(name)
	return iface ? iface['networkIP'] : null
    }
    publicIP(name) { return this.instancePublicIP(name) }
    privateIP(name) { return this.instancePrivateIP(name) }
    
    instanceMetadata(instance) {
	let {cloud} = this
	return cloud && cloud.instances && cloud.instances[instance]
	    ? ((cloud && cloud.instances) ? cloud.instances.metadata : null)
	    : null
    }

    instanceMeta(instance) {  return this.instanceMetadata(instance) }
    
    instanceCIDR(instance) {
	return this.subnetCidr()
	let metadata = this.instanceMetadata(instance),
	    cidr = metadata && metadata.items && metadata.items[0]
	return cidr || this.subnetCidr()
    }
    
    
    subnetCidr() { return this.cloud.subnet
		   ? this.cloud.subnet['ipCidrRange']
		   : null }
    
    forwardingIP(name) {
	let {cloud={}} = this,
	    {forwarding={}} = cloud,
	    forward = forwarding ? forwarding[name] : null
	return forward ? forward['IPAddress'] : null
    }

    // ACTIONS - START

    start() {
	return this.create()
	    .then(_ => this.distribute())
	    .then(_ => this.update())
    }
    
    // ACTIONS - CREATION


    status() {
	return (this.cloud && this.cloud.network)
	    ? Promise.resolve(this.cloud)
	    : this
	    .fetch()
    }
    
    create(type='') {
	return this.storeStatus(true)
	    .then(_ => {
		if (type.match(/^cert(ificate)s?/i))
		    return this.create_certificates()
		else if (type.match(/^(kube)?config(uration)?s?/i))
		    return this.create_configurations()
		else if (type.match(/^net(works?)?/i))
		    return this.create_network()
		else if (type.match(/^rules?/i))
		    return this.create_rules()
		else if (type.match(/^encryption?/i))
		    return this.create_encryption()
		else if (type.match(/^instances?/i))
		    return this.create_instances()
		else if (!type || type.match(/^all$/i))
		    return this.up()
	    })
    }

    display() {
	console.log('Health forwarded at ' + this.forwardingIP('health'))
	console.log('API forwarded at ' + this.forwardingIP('api'))
    }
    
    up() {
	return this.create_network()
	    .then(_ => this.create_rules())
	    .then(_ => this.create_instances())
	    .then(_ => this.storeStatus(true))
	    .then(_ => this.create_certificates())
	    .then(_ => this.create_configurations())
    }
    
    storeStatus(force) {
	return Promise.resolve(force ? (this.cloud = null) : null)
	    .then(_ => this
	    .status()
	    .then(_ => new Promise(
		(res, rej) => fs
		    .writeFile('files/status.json',
			       JSON.stringify(this.cloud || _, null, 2),
			       err => {
				   if (!err) return res(this.cloud = _)
				   console.error(err)
				   rej(err)
			       }
			      )
	    ))
		 )
    }
    
    create_certificate(cn) {
	this.mkdirs()
	console.log('API: ' + this.forwardingIP('api'))
	let cluster = this,
	    {cloud,config} = this,
	    {app} = config,
	    instances = cloud && cloud.instances,
	    initCa = (cn == 'ca'),
	    log = console.log(`Creating certificate for ${cn}`),
	    defaultCsr = config && config.cluster.csr,
	    workerHosts = [] || [cn, this.privateIP(cn), '127.0.0.1'],
	    kubernetesHosts = (
		[this.forwardingIP('api'), '127.0.0.1', 'kubernetes.default']
		    .concat(
			this
			    .controllers()
			    .map(name =>  [name, this.publicIP(name), this.privateIP(name)])
			    .reduce((sum, next) => sum.concat(next), [])
		    )
	    ),
	    hostnames = (cn.match('worker'))
	    ? workerHosts
	    : (	(cn == 'kubernetes') ? kubernetesHosts : null),
	    organizations = {
		'kube-proxy': 'system:node-proxier',
		'worker': "system:nodes",
		'kube-controller-manager': "system:kube-controller-manager",
		'kube-scheduler': "system:kube-scheduler",
		'admin': "system:masters",
	    },
	    organization = cn.match('worker')
	    ? organizations['worker']
	    : ( cn.match(/^(ca|service-account)$/) ? app.toUpperCase() : organizations[cn]),
	    names = [
		Object.assign(
		    {},
		    defaultCsr,
		    {O: organization ? organization : defaultCsr['O']}
		)
	    ],
	    fullCn = (
		cn.match('worker')
		    ? `system:node:${cn}`
		    : ((cn.match('kube-')) ? `system:${cn}` : (initCa ? app.toUpperCase() : cn))
	    ),
	    csr = {
		CN: fullCn,
		names,
		key: {
		    algo: 'rsa',
		    size: 2048,
		}
	    },
	    opts = (
		(initCa)
		    ? ['initca']
		    : ['ca=files/certs/ca.pem',
		       'ca-key=files/certs/ca-key.pem'
		      ].concat(
			  (hostnames && hostnames.length)
			      ? `hostname=${hostnames.join(',')}`
			      : []
		      )
	    ).map(_ => `-${_}`)
	    .join(' '),
	    outputPrefix = `files/${cn.match('worker') ? (cn + '/' + cn) : ('certs/' + cn)}`,
	    csrPath = `files/${cn.match('worker') ? cn : 'certs'}/${cn}-csr.json`,
	    genCert = `cfssl gencert -config=ca-config.json -profile=kubernetes ${opts} ${csrPath}`,
	    bundleConvert = `cfssljson -bare ${outputPrefix}`

	console.log(`Generating ${outputPrefix}.pem + ${outputPrefix}-key.pem`)

	console.log(`${genCert} | ${bundleConvert}`)
	return new Promise(
	    (resolve, reject) => fs
		.writeFile(csrPath,
			   JSON.stringify(csr, null, 2),
			   err => {
			       if (err) {
				   console.error(err)
				   return reject(err)
			       }
			       shell
				   .exec(genCert, {silent: true})
				   .exec(bundleConvert, {silent: true})
			       fs.unlink(csrPath, _ => {
				   fs.unlink(csrPath.replace('-csr.json',
							     '.csr'),
					     _ => resolve(true)
					    )})
			   })
	)
    }
    
    create_certificates() {
	console.log("Creating SSL Certificates")
	let creation = _ => ['ca',
			     'kube-controller-manager',
			     'kube-proxy',
			     'kubernetes',
			     'kube-scheduler',
			     'admin',
			     'service-account'
			    ]
	    .concat(this.workers())
	    .map(name => this.create_certificate(name)),
	    promise = res => Promise
	    .all(creation())
	    .then(_ => res(true)),
	    setup = res => fs.mkdir('files', {}, err => {
		fs.mkdir('files/certs', {}, err => {
		    promise(res)
		})
	    })
	return new Promise((res, rej) => setup(res))
    }
    

    create_network() {
	console.log('Creating network')
	let {app,cluster} = this.config,
	    network = app
	return this.compute(`networks create ${network} `)
    }


    create_rules() {
	let {app,cluster} = this.config,
	    {ports} = cluster,
	    network = app,
	    name = app,
	    {region,zone} = cluster,
	    controllerPorts = [ports.ssh, ports.health, ports.api, ports.etcd.peer, ports.etcd.client]
	    .map(_ => `tcp:${_}`).join(','),
	    apiPort = ports.api,
	    healthPort = ports.health,
	    etcdClientPort = ports.etcd.client,
	    etcdPeerPort = ports.etcd.peer,
	    workerPorts = [ports.ssh, ports.api]
	    .map(_ => `tcp:${_}`).join(','),
	    allPorts = controllerPorts,
	    namedPorts = ['api', 'health']

	return this
	    .compute(`http-health-checks create ${app} --port=${ports.health} --request-path=/healthz`)
	    .then(_ => this
		  .compute(`target-pools create ${app} --http-health-check=${app}`)
		 )
	    .then(_ => 0 && this
		  .compute(`instance-groups unmanaged create ${app} `
			   + ` --zone=${zone} `
			  )
		 )
	    .then(_ => 0 && this
		  .compute(`instance-groups unmanaged set-named-ports ${app}`
			   + ` --named-ports `
			   + namedPorts.map(_ => `${_}:${ports[_]}`).join(',')
			  )
		 )
	    .then(_ => 0 && this
		  .compute(`backend-services create health --health-checks=${app}`
			   + ` --port-name=health `
//			   + ` --region=${region} `
			   + ` --global `
//			   + `--protocol=HTTP`
			   + `--protocol=TCP`
			  )
		 )
	    .then(_ => 0 && this
		  .compute(`backend-services create api --health-checks=${app}`
			   + ` --port-name=health `
//			   + ` --region=${region} `
			   + ` --global `
//			   + `--protocol=HTTPS`
			   + `--protocol=TCP`
			  )
		 )
	    .then(() => 0 && Promise.all(
		namedPorts.map(_ => this.compute(
		    `backend-services add-backend ${_} --instance-group=${app}`
			+ ` --instance-group-zone=${zone}`
//			+ ` --region=${region}`
			+ ` --global`
		))
	    ))
//	    .then(_ => this.compute(`url-maps create ${app} --default-service=api`))
//	    .then(_ => this.compute(`url-maps add-path-matcher ${app} ` +
//				    `--path-matcher-name=${app}  --path-rules '/healthz/*=health' `
//				    + `--default-service=api`))
//	    .then(_ => this.compute(`ssl-certificates create ${app} ` +
//				    `--certificate=files/certs/ca.pem `
//				    + `--private-key=files/certs/ca-key.pem`))
//	    .then(_ => this.compute(`target-http-proxies create health --url-map=${app}`))
//	    .then(_ => this.compute(`target-https-proxies create api --url-map=${app} `
//				    + `--ssl-certificates=${app}`))
//	    .then(_ => this.compute(`target-tcp-proxies create health `
//				    + `--backend-service=health`))
//	    .then(_ => this.compute(`target-tcp-proxies create api `
//				    + `--backend-service=api`))
	    .then(_ => this
		  .compute(`forwarding-rules create health `
			   + `--region=${region} `
//			   + ` --global`
			   + ` --load-balancing-scheme=EXTERNAL `
			   + `  --ip-protocol=TCP`
//			   + `  --ip-protocol=HTTP`
//			   + ` --target-tcp-proxy=health `
			   //			   + ` --target-http-proxy=health `
			   + ` --target-pool ${app} `
			   + ` --ports=${ports.health}`
			  )
		 )
	    .then(_ => this
		  .compute(`forwarding-rules create api `
			   + `--region=${region} `
//			   + ` --global`
			   + `  --ip-protocol=TCP `
//			   + `  --ip-protocol=HTTPS `
			   + ` --load-balancing-scheme=EXTERNAL `
//			   + ` --target-https-proxy=api `
//			   + ` --target-tcp-proxy=api `
			   + ` --target-pool ${app} `
			   + ` --ports=${ports.api}`
			  )
		 )
    	    .then(_ => this
		  .compute(`firewall-rules create ${app} --network=${network} `
			   + `--allow ${allPorts}`)
		 )
	    .then(_ => this.storeStatus())
	    .then(_ => {
		this.display()
		return _
	    })
		 
    }
    
    create_instances() {
	console.log('Creating instances')

	let {app,cluster} = this.config,
	    subnet = app,
	    network = app,
	    {image,machine,region,zone} = cluster,
	    machineConf = `--machine-type=${machine.type} --network=${network}`,
	    scopes = `--scopes compute-rw,storage-ro,service-management,service-control,logging-write,monitoring`,
	    meta = (type, num) => (type == 'worker')
	    ? `--metadata pod-cidr=10.200.${num}.0/24`
	    : '',
	    typeConf = (type, num) => meta(type, num),
	    imageConf = `--image-project=${image.project} --image-family=${image.family}`,
//	    priorityConf = '--preemptible --no-restart-on-failure',
	    priorityConf = ' --no-restart-on-failure',
	    label = _ => _.match('controller') ? 'controller' : 'worker',
	    labelConf = _ => `--labels=role=${label(_)} --tags=${label(_)}`,
	    conf = (_,num) => ` ${ typeConf(_, num) } --can-ip-forward ${machineConf} `
	    + `${imageConf} ${priorityConf} ${labelConf(_)}`,
	    zoneConf = () => `--zone=${zone}`,
	    workers = this.instanceNames('worker'),
	    controllers = this.instanceNames('controller')


	return this
	    .compute(`instances create ${zoneConf()} ${controllers.join(' ')} ${conf('controller')}`)
	    .then(_ => this.compute(`target-pools add-instances ${app} --instances=${controllers.join(',')}`))
//	    .then(_ => this.compute(`instance-groups add-instances ${app} ${zoneConf()} ` +
//				    `--instances=${controllers.join(',')}`))
	    .then(_ => workers.map((name, idx) => `instances create ${name} `
				   + `${zoneConf()} ${conf('worker', idx + 1)}`))
	    .then(_ => Promise.all( _.map(_ => this.compute(_)) ))
	    .then(_ => this.storeStatus())
	    .then(_ => true)
    }
    
    nodeIps(type) {
	return this.roleRange(type)
	    .map(_ => this.instancePublicIP(`${type}-${ _}`)
		 || this.instancePrivateIP(`${type}-${ _}`)
		)
    }


    teardown() { return this.down() }
    down() {
	let {app,cluster} = this.config,
	    network = app,
	    {region,zone,ports} = cluster,
	    namedPorts = ['api', 'health']
	console.log('Tearing down')
	let instances = 'instances delete ' + this.instanceNames().join(' '),
	    firewalls = `firewall-rules delete ${app}`,
	    forwarding = namedPorts.map(_ => `forwarding-rules delete ${_} --region=${region}`),
	    targets = [
		`target-http-proxies delete health`,
		`target-https-proxies delete api`,
		`target-tcp-proxies delete ${app}`,
		`target-tcp-proxies delete health`,
		`target-tcp-proxies delete api`,
		      ],
	    sslcerts = `ssl-certificates delete ${app}`,
	    urlmaps = `url-maps delete ${app}`,
	    backends = namedPorts.map(_ => `backend-services delete ${_} --global`),
	    health = [
		`health-checks delete ${app}`,
		`http-health-checks delete ${app}`,
	    ],
	    instancegroups = `instance-groups unmanaged delete ${app}`,
	    targetPools = `target-pools delete ${app}`,
	    networks = [  `networks delete ${network}` ],
	    components = [].concat(
		firewalls,
		forwarding,
		targets,
		sslcerts,
		urlmaps,
		backends,
		instancegroups,
		targetPools,
		instances,
		health,
		networks
	    ),
	    next = (resolve, reject, components) => components.length
	    ? this
	    .compute(components.shift())
	    .then(_ => next(resolve, reject, components)
		 )
	    .catch(reject)
	    : resolve(true)
	return new Promise((resolve, reject) => next(resolve, reject, components))
    }


    create_contexts() {
	console.log('Creating contexts')
	let {config} = this,
	    {app} = config,
	    contexts = [
		'kube-proxy', 'kube-controller-manager','kube-scheduler',
		'admin',
		app
	].concat( this.workers() )
	return Promise
	    .all( contexts.map(_ => this.create_context(_)) )
	    .then(_ => true)
    }
    
    create_context(name) {
	// config set-cluster ${app}
	let {config} = this,
	    {app} = config,
	    forwarding = this.forwardingIP('api'),
	    clusterOpts = {
		'certificate-authority': 'files/certs/ca.pem',
		'embed-certs': 'true',
		server: `https://${name.match(/(admin|kube-(controller-manager|scheduler))/) ? '127.0.0.1' : this.forwardingIP('api')}:${config.cluster.ports.api}`,
	    }, credentialOpts = {
		//config set-credentials system:node:${app}
		'client-certificate': `files/${ (app != name) ? (name.match('worker') ? (name + '/' + name) : ('certs/' + name)) : 'certs/admin' }.pem`,
		'client-key': `files/${ (app != name) ? (name.match('worker') ? (name + '/' + name) : ('certs/' + name)) : 'certs/admin' }-key.pem`,
		'embed-certs': 'true',
	}, contextOpts = {
	    // config set-context default
	    cluster: app,
	    user: name.match('worker') ? `system:node:${name}` : (name.match('kube-') ? `system:${name}` : name)
	},
	    kubeconfig = (name == app) ? '' : `--kubeconfig=files/${name.match('worker') ? (name + '/' + name) : name}.kubeconfig`,
	    opts = input => Object.keys(input).map(_ => `--${_}=${input[_]}`).join(' '),
	    defaultFlag = (1 || (name != app)) ? 'default' : ''
	return this.exec(`kubectl config set-cluster ${app} ${opts(clusterOpts)} ${kubeconfig}`)
	    .then(_ => this.exec(`kubectl config set-credentials ` +
				 `${(name.match('worker')) ? ('system:node:' + name) :
 ((name.match('kube-')) ? `system:${name}` : name)} ${opts(credentialOpts)} ${kubeconfig}`))
	    .then(_ => 
		  this.exec(`kubectl config set-cluster ${app} ${opts(clusterOpts)} ${kubeconfig}`)
		 )
	    .then(_ => this.exec(`kubectl config set-context default ${opts(contextOpts)} ${kubeconfig}`))
	    .then(_ => this.exec(`kubectl config use-context default  ${kubeconfig}`))
    }

    create_configurations() {
	console.log('Creating configurations')
	this.mkdirs()
	let {config, cidrs} = this,
	    {app} = config,
	    mkFiles = (instance, instance_index, files) => new Promise(
		(res) => fs
		    .mkdir(`files${instance ? ('/' + instance) : '/'}`,
			   _ => res(
			       files.map( _ => this.renderFile(
				   _,
				   {instance, instance_index},
				   (instance ) ? `${instance}/${_}` : _
			       ))
			   )))
	    .then(_ => Promise.all(_)),
	    make = (type, files) => this[type + 's']()
	    .map((_, num) => mkFiles(_, num + 1, files || FILES[type]))
	return this
	    .storeStatus()
	    .then(_ => make('controller').concat( make('worker') ) )
	    .then(_ => Promise.all(_))
	    .then(_ => this.create_contexts())
	    .then(_ => this.workers().map(instance => this.create_bootstrap(instance)))
	    .then(_ => Promise.all(_))
	    .then(_ => true)
    }

    // ACTIONS - RESET
    reset() {
	return this.teardown().then(_ => this.start())
    }

    // ACTIONS - DISTRIBUTE

    mkdirs() {
	console.log('Making local directories..')
	let dirs = ['files/', 'files/certs']
	    .concat(this.instanceNames().map(_ => `files/${_}`))
	dirs.forEach(_ => { try { fs.mkdirSync(_) } catch(e) { } })
    }

    workersOn() { return this.workers().filter(_ => this.publicIP(_)) }
    controllersOn() { return this.controllers().filter(_ => this.publicIP(_)) }
    
    distribute() { 
	console.log("Distributing files")

	let controllers = this
	    .controllers()
	    .map(instance => {
		
		let files = ['ca', 'kubernetes', 'service-account']
		    .map(_ => 'files/certs/' + _)
		    .map(cert => `${cert}.pem ${cert}-key.pem`)
		    .concat(['kube-controller-manager', 'kube-scheduler', 'admin']
			    .map(_ => `files/${_}.kubeconfig`))
		    .join(' ') + ` files/${instance}/* files/bootstrap_secret-worker*.yaml `
		    + `files/bootstrap_configmap-worker*.yaml`
		 
		return this.compute(`scp ${files} ${instance}:~/`)
	    }),
	    workers = this
	    .instanceNames('worker')
	    .map(instance => {
		let files = `files/${instance}/kubelet-bootstrap.kubeconfig files/kube-proxy.kubeconfig `
		    + `files/certs/ca.pem files/${instance}/*`
		return this.compute(`scp ${files} ${instance}:~/`)
	    })
	return Promise.all(controllers.concat(workers)).then(_ => true)
    }

    // ACTIONS - UPDATE
    update() {
	return this.update_os()
    }

    update_os() {
	let types = ['controller', 'worker'],
	    script = type => `${type}.sh`,
	    updates = types
	    .map(type => this
		 .instanceNames(type)
		 .map(instance => `ssh ${instance} -- -t -- sudo bash ${type}.sh`)
		)
	    .reduce((sum, next) => sum.concat(next), [])
	    .map(update => this.compute(update))
	return Promise.all(updates).then(_ => this.display())
    }

    readFile(file) {
	return new Promise((res, rej) => 
			   fs.readFile(file,
				       (err, data) => {
					   err ? rej(err) : res(data)
				       })
			  )
    }
    copyFile(src, dest) {
	return new Promise((res, rej) => 
			   fs.copyFile(src, dest,
				       (err) => {
					   err ? rej(err) : res(true)
				       })
			  )
    }

    create_bootstrap(instance) {
	console.log(`Creating bootstrap files for ${instance}`)
	let id = RandomString.generate(6).toLowerCase(),
	    secret = RandomString.generate(16).toLowerCase(),
	    key = `${id}.${secret}`,
	    token = {id, secret, key},
	    signature = kubeconfig => jws.sign({
		header: { alg: 'HS256' },
		payload: kubeconfig,
		// jws module's "secret" is the jws key, not kube secret
		secret: key
	    }).replace(/\..+\./, '..')
	
	return this
	    .renderFile(
		'bootstrap_secret.yaml',
		{token},
		`bootstrap_secret-${instance}.yaml`
	    )
//	    .then(_ => this.readFile(
//		'files/certs/ca.pem'))
//	    .then(certificate => this.render(
//		'ejs/kubelet.kubeconfig.ejs',
//		{token, certificate: `${certificate}`.replace(/\n/gm, '')}))
	    .then(_ => this.readFile(
		`files/${instance}/${instance}.kubeconfig`))
	    .then(kubeconfig => this.renderFile(
		'bootstrap_configmap.yaml',
		{token,
		 signature: signature(kubeconfig),
		 kubeconfig: `${kubeconfig}`.replace(/\n/gm, "\n    ") },
		`bootstrap_configmap-${instance}.yaml`
	    ))
	    .then(_ => this.renderFile('kubelet-bootstrap.kubeconfig',
				       {token},
				       `${instance}/kubelet-bootstrap.kubeconfig`
				      ))
	    .then(_ => this.renderFile('bootstrappers.yaml', {}))
	    .then(_ => console.log('Bootstrap files written'))
	    .then(_ => true)
    }
}

export default K8S



